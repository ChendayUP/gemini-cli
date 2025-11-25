/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 许可证块结束

import * as vscode from 'vscode'; // VS Code 扩展 API
import {
  // 从核心包导入 IDE 交互相关的 zod schema
  CloseDiffRequestSchema, // 关闭 diff 工具调用输入 schema
  IdeContextNotificationSchema, // IDE 上下文更新通知 schema
  OpenDiffRequestSchema, // 打开 diff 工具调用输入 schema
} from '@google/gemini-cli-core/src/ide/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'; // 判断 JSON-RPC 请求是否为初始化请求
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; // MCP 服务器实现
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'; // 支持 SSE 的 HTTP 传输
import express, { // 引入 express 框架构建 HTTP 服务
  type Request, // 请求类型
  type Response, // 响应类型
  type NextFunction, // 中间件下一步回调类型
} from 'express';
import cors from 'cors'; // CORS 中间件, 控制跨域来源
import { randomUUID } from 'node:crypto'; // 生成随机认证 token
import { type Server as HTTPServer } from 'node:http'; // Node 原生 HTTP Server 类型
import * as path from 'node:path'; // 路径操作工具
import * as fs from 'node:fs/promises'; // Promise 风格文件系统 API
import * as os from 'node:os'; // OS 相关 (临时目录等)
import type { z } from 'zod'; // zod 类型支持
import type { DiffManager } from './diff-manager.js'; // Diff 管理器类型
import { OpenFilesManager } from './open-files-manager.js'; // 打开文件与选区状态管理器

class CORSError extends Error {
  // 自定义 CORS 错误类型
  constructor(message: string) {
    // 构造函数接收错误消息
    super(message); // 调用基类构造
    this.name = 'CORSError'; // 设置错误名称便于区分
  } // 构造函数结束
} // 类定义结束

const MCP_SESSION_ID_HEADER = 'mcp-session-id'; // 请求头键: 携带当前 MCP 会话 ID
const IDE_SERVER_PORT_ENV_VAR = 'GEMINI_CLI_IDE_SERVER_PORT'; // 暴露给终端的环境变量: IDE 服务器端口
const IDE_WORKSPACE_PATH_ENV_VAR = 'GEMINI_CLI_IDE_WORKSPACE_PATH'; // 暴露工作区路径集合 (多路径以分隔符拼接)

interface WritePortAndWorkspaceArgs {
  // 写入端口与工作区辅助函数的参数接口
  context: vscode.ExtensionContext; // 扩展上下文对象
  port: number; // 服务器监听端口
  portFile: string; // 端口信息文件路径 (基于端口号)
  ppidPortFile: string; // 基于父进程 PID 的兼容文件路径
  authToken: string; // 认证 token
  log: (message: string) => void; // 日志输出函数
}

async function writePortAndWorkspace({
  // 将端口与工作区写入环境变量及临时文件 (供 CLI 发现)
  context, // 上下文对象
  port, // 端口号
  portFile, // 端口文件路径
  ppidPortFile, // 父进程端口文件路径
  authToken, // 认证 token
  log, // 日志函数
}: WritePortAndWorkspaceArgs): Promise<void> {
  // 返回 Promise<void>
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspacePath =
    workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders.map((folder) => folder.uri.fsPath).join(path.delimiter)
      : '';

  context.environmentVariableCollection.replace(
    // 设置端口环境变量 (终端继承)
    IDE_SERVER_PORT_ENV_VAR, // 键: 端口变量名
    port.toString(), // 值: 字符串形式端口
  );
  context.environmentVariableCollection.replace(
    // 设置工作区路径集合环境变量
    IDE_WORKSPACE_PATH_ENV_VAR, // 键: 工作区路径变量名
    workspacePath, // 值: 多路径拼接字符串或空
  );

  const content = JSON.stringify({
    // 构建写入文件的 JSON 内容
    port, // 端口号
    workspacePath, // 工作区路径集合
    ppid: process.ppid, // 父进程 PID (用于匹配当前 IDE 主进程)
    authToken, // 认证 token
  });

  log(`写入端口文件: ${portFile}`); // 日志: 端口文件路径
  log(`写入 PPID 端口文件: ${ppidPortFile}`); // 日志: 父进程端口文件路径

  try {
    // 写文件并设置权限
    await Promise.all([
      fs.writeFile(portFile, content).then(() => fs.chmod(portFile, 0o600)), // 写端口文件并 chmod 600
      fs
        .writeFile(ppidPortFile, content) // 写父进程文件
        .then(() => fs.chmod(ppidPortFile, 0o600)), // chmod 600 仅当前用户可读写
    ]);
  } catch (err) {
    // 捕获写入异常
    const message = err instanceof Error ? err.message : String(err); // 标准化错误消息
    log(`写端口信息文件失败: ${message}`); // 输出错误日志
  }
}

function sendIdeContextUpdateNotification( // 将当前 IDE 上下文通过会话传输发送给 CLI
  transport: StreamableHTTPServerTransport, // 目标连接传输实例
  log: (message: string) => void, // 日志函数 (当前未使用, 保留拓展能力)
  openFilesManager: OpenFilesManager, // 打开文件管理器 (提供最新状态)
) {
  const ideContext = openFilesManager.state; // 获取当前上下文 (打开文件列表+活动文件选区+信任状态)
  const notification = IdeContextNotificationSchema.parse({
    // 构建并校验通知对象
    jsonrpc: '2.0', // JSON-RPC 版本号
    method: 'ide/contextUpdate', // 方法名
    params: ideContext, // 参数: 上下文数据
  });
  transport.send(notification); // 通过 SSE 发送通知
}

export class IDEServer {
  // IDE 服务器: 管理 HTTP 服务 + MCP 会话 + 状态广播
  private server: HTTPServer | undefined; // 底层 HTTP 服务器实例
  private context: vscode.ExtensionContext | undefined; // 扩展上下文引用
  private log: (message: string) => void; // 日志函数
  private portFile: string | undefined; // 端口信息文件路径
  private ppidPortFile: string | undefined; // 父进程端口文件路径
  private port: number | undefined; // 实际监听端口
  private authToken: string | undefined; // 随机认证 token
  private transports: { [sessionId: string]: StreamableHTTPServerTransport } =
    {}; // 活跃会话传输表
  private openFilesManager: OpenFilesManager | undefined; // 打开文件状态管理器实例
  diffManager: DiffManager; // diff 管理器实例 (供工具使用)

  constructor(log: (message: string) => void, diffManager: DiffManager) {
    // 构造函数
    this.log = log; // 保存日志函数
    this.diffManager = diffManager; // 保存 diff 管理器实例
  }

  start(context: vscode.ExtensionContext): Promise<void> {
    // 启动服务器, 返回完成的 Promise
    return new Promise((resolve) => {
      this.context = context;
      this.authToken = randomUUID();
      const sessionsWithInitialNotification = new Set<string>();

      const app = express(); // 创建 express 应用
      app.use(express.json({ limit: '10mb' })); // 安装 JSON 体解析中间件 (10MB 限制)

      app.use(
        // 安装 CORS 中间件
        cors({
          // 配置来源策略
          origin: (origin, callback) => {
            // 自定义来源验证逻辑
            if (!origin) {
              // 没有 origin (非浏览器) 允许
              return callback(null, true); // 通过
            }
            return callback(
              // 有 origin 认为是浏览器跨域, 拒绝
              new CORSError('Request denied by CORS policy.'), // 抛出自定义错误
              false, // 失败
            );
          },
        }),
      );

      app.use((req, res, next) => {
        // Host 头校验中间件
        const host = req.headers.host || ''; // 获取 Host
        const allowedHosts = [
          // 允许访问的主机列表
          `localhost:${this.port}`, // localhost 搭配端口
          `127.0.0.1:${this.port}`, // 127.0.0.1 搭配端口
        ];
        if (!allowedHosts.includes(host)) {
          // 不在允许范围
          return res.status(403).json({ error: 'Invalid Host header' }); // 返回 403
        }
        next(); // 继续后续中间件
      });

      app.use((req, res, next) => {
        // Bearer Token 认证中间件
        const authHeader = req.headers.authorization; // 读取 Authorization
        if (!authHeader) {
          // 缺失认证头
          this.log('缺少 Authorization 头, 拒绝访问');
          res.status(401).send('Unauthorized');
          return;
        }
        const parts = authHeader.split(' '); // 拆分为 [Bearer, token]
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
          // 格式错误
          this.log('Authorization 头格式错误, 拒绝访问');
          res.status(401).send('Unauthorized');
          return;
        }
        const token = parts[1]; // 提取 token
        if (token !== this.authToken) {
          // token 不匹配
          this.log('认证 token 无效, 拒绝访问');
          res.status(401).send('Unauthorized');
          return;
        }
        next(); // 通过认证
      });

      const mcpServer = createMcpServer(this.diffManager, this.log); // 创建 MCP 服务器并注册工具

      this.openFilesManager = new OpenFilesManager(context); // 初始化文件管理器 (跟踪打开文件/选区)
      const onDidChangeSubscription = this.openFilesManager.onDidChange(() => {
        // 文件状态变化回调
        this.broadcastIdeContextUpdate(); // 广播最新上下文
      });
      context.subscriptions.push(onDidChangeSubscription); // 加入上下文生命周期管理
      const onDidChangeDiffSubscription = this.diffManager.onDidChange(
        // diff 状态变化订阅
        (notification) => {
          // 接收到 diff 接受/关闭通知
          for (const transport of Object.values(this.transports)) {
            // 遍历所有会话传输
            transport.send(notification); // 转发通知到 CLI
          }
        },
      );
      context.subscriptions.push(onDidChangeDiffSubscription); // 保存订阅便于自动释放

      app.post('/mcp', async (req: Request, res: Response) => {
        // 处理带请求体的 MCP 调用 (初始化或工具调用)
        const sessionId = req.headers[MCP_SESSION_ID_HEADER] as
          | string
          | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && this.transports[sessionId]) {
          // 已有会话 ID -> 复用传输
          transport = this.transports[sessionId]; // 取出对应传输
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // 无会话 ID 且是初始化请求 -> 新建会话
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              this.log(`New session initialized: ${newSessionId}`);
              this.transports[newSessionId] = transport;
            },
          });
          let missedPings = 0;
          const keepAlive = setInterval(() => {
            const sessionId = transport.sessionId ?? 'unknown';
            transport
              .send({ jsonrpc: '2.0', method: 'ping' })
              .then(() => {
                missedPings = 0;
              })
              .catch((error) => {
                missedPings++;
                this.log(
                  `Failed to send keep-alive ping for session ${sessionId}. Missed pings: ${missedPings}. Error: ${error.message}`,
                );
                if (missedPings >= 3) {
                  this.log(
                    `Session ${sessionId} missed ${missedPings} pings. Closing connection and cleaning up interval.`,
                  );
                  clearInterval(keepAlive);
                }
              });
          }, 60000); // 60 sec

          transport.onclose = () => {
            // 会话关闭回调
            clearInterval(keepAlive); // 清理保活定时器
            if (transport.sessionId) {
              // 若有会话 ID
              this.log(`Session closed: ${transport.sessionId}`); // 记录关闭日志
              sessionsWithInitialNotification.delete(transport.sessionId); // 移除初始通知标记
              delete this.transports[transport.sessionId]; // 删除传输引用
            }
          };
          mcpServer.connect(transport); // 连接该传输到 MCP 服务器
        } else {
          // 既不是已有会话也不是初始化 -> 错误请求
          this.log(
            'Bad Request: No valid session ID provided for non-initialize request.',
          );
          res.status(400).json({
            // 返回 JSON-RPC 错误结构
            jsonrpc: '2.0', // 版本号
            error: {
              // 错误对象
              code: -32000, // 自定义错误码
              message:
                'Bad Request: No valid session ID provided for non-initialize request.', // 错误信息
            },
            id: null, // 没有对应请求 ID
          });
          return; // 结束处理
        }

        try {
          // 让传输处理该请求 (工具调用 / 初始化)
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          // 捕获处理异常
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          this.log(`处理 MCP 请求出错: ${errorMessage}`);
          if (!res.headersSent) {
            // 若尚未发送响应
            res.status(500).json({
              // 返回内部错误 JSON-RPC 标准结构
              jsonrpc: '2.0' as const,
              error: { code: -32603, message: 'Internal server error' }, // 标准内部错误码
              id: null,
            });
          }
        }
      });

      const handleSessionRequest = async (req: Request, res: Response) => {
        // GET /mcp: 用于建立/续打事件流 (SSE)
        const sessionId = req.headers[MCP_SESSION_ID_HEADER] as
          | string
          | undefined;
        if (!sessionId || !this.transports[sessionId]) {
          this.log('Invalid or missing session ID'); // 会话 ID 缺失或不存在
          res.status(400).send('Invalid or missing session ID'); // 返回 400 文本错误
          return;
        }

        const transport = this.transports[sessionId]; // 获取当前会话传输
        try {
          // 尝试处理请求 (SSE 连接握手等)
          await transport.handleRequest(req, res);
        } catch (error) {
          // 捕获异常
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          this.log(`Error handling session request: ${errorMessage}`); // 记录日志
          if (!res.headersSent) {
            // 若未发送响应头
            res.status(400).send('Bad Request'); // 返回 400 错误
          }
        }

        if (
          // 若需发送首次上下文
          this.openFilesManager && // 文件管理器已初始化
          !sessionsWithInitialNotification.has(sessionId) // 该会话尚未发送过初始上下文
        ) {
          sendIdeContextUpdateNotification(
            // 发送上下文更新通知
            transport,
            this.log.bind(this),
            this.openFilesManager,
          );
          sessionsWithInitialNotification.add(sessionId); // 标记已经发送
        }
      };

      app.get('/mcp', handleSessionRequest); // 注册 GET /mcp 路由

      app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
        // 全局错误处理中间件
        this.log(`Error processing request: ${err.message}`); // 打印错误信息
        this.log(`Stack trace: ${err.stack}`); // 打印堆栈
        if (err instanceof CORSError) {
          // CORS 错误单独处理
          res.status(403).json({ error: 'Request denied by CORS policy.' }); // 403 返回
        } else {
          // 其他错误传递
          next(err);
        }
      });

      this.server = app.listen(0, '127.0.0.1', async () => {
        // 随机端口监听 (仅 127.0.0.1)
        const address = (this.server as HTTPServer).address();
        if (address && typeof address !== 'string') {
          this.port = address.port;
          this.portFile = path.join(
            os.tmpdir(),
            `gemini-ide-server-${this.port}.json`,
          );
          this.ppidPortFile = path.join(
            os.tmpdir(),
            `gemini-ide-server-${process.ppid}.json`,
          );
          this.log(`IDE server listening on http://127.0.0.1:${this.port}`);

          if (this.authToken) {
            // 已生成 token 时写入文件与环境变量
            await writePortAndWorkspace({
              // 写端口与工作区信息
              context,
              port: this.port,
              portFile: this.portFile,
              ppidPortFile: this.ppidPortFile,
              authToken: this.authToken,
              log: this.log,
            });
          }
        }
        resolve();
      });

      this.server.on('close', () => {
        // 服务器关闭事件
        this.log('IDE server connection closed.'); // 日志: 连接关闭
      });

      this.server.on('error', (error) => {
        // 服务器错误事件
        this.log(`IDE server error: ${error.message}`); // 输出错误
      });
    });
  }

  broadcastIdeContextUpdate() {
    // 广播当前 IDE 上下文给所有活跃会话
    if (!this.openFilesManager) {
      // 未初始化文件管理器则直接返回
      return;
    }
    this.log('Broadcasting IDE context update to session begin');
    for (const transport of Object.values(this.transports)) {
      this.log('Broadcasting IDE context update to session:');
      // 遍历所有会话传输
      sendIdeContextUpdateNotification(
        // 发送上下文通知
        transport,
        this.log.bind(this),
        this.openFilesManager,
      );
    }
  }

  async syncEnvVars(): Promise<void> {
    // 同步端口与工作区环境变量 + 广播上下文
    if (
      // 检查所有必要状态是否存在
      this.context &&
      this.server &&
      this.port &&
      this.portFile &&
      this.ppidPortFile &&
      this.authToken
    ) {
      await writePortAndWorkspace({
        // 写入最新端口与工作区信息
        context: this.context,
        port: this.port,
        portFile: this.portFile,
        ppidPortFile: this.ppidPortFile,
        authToken: this.authToken,
        log: this.log,
      });
      this.broadcastIdeContextUpdate(); // 广播最新上下文
    }
  }

  async stop(): Promise<void> {
    // 停止服务器: 关闭监听并清理临时文件与环境变量
    if (this.server) {
      // 若服务器实例存在
      await new Promise<void>((resolve, reject) => {
        // 包装为 Promise
        this.server!.close((err?: Error) => {
          // 调用 close 关闭 HTTP 服务
          if (err) {
            // 关闭失败
            this.log(`Error shutting down IDE server: ${err.message}`); // 记录错误
            return reject(err); // 拒绝 Promise
          }
          this.log(`IDE server shut down`); // 成功关闭日志
          resolve(); // 解决 Promise
        });
      });
      this.server = undefined; // 清空引用
    }
    if (this.context) {
      // 清理扩展环境变量集合
      this.context.environmentVariableCollection.clear();
    }
    if (this.portFile) {
      // 删除端口文件 (忽略不存在错误)
      try {
        await fs.unlink(this.portFile);
      } catch (_err) {
        // Ignore error if file does not exist, as it might have already been deleted.
      }
    }
    if (this.ppidPortFile) {
      // 删除父进程端口文件
      try {
        await fs.unlink(this.ppidPortFile);
      } catch (_err) {
        // Ignore error if file does not exist, as it might have already been deleted.
      }
    }
  }
}

const createMcpServer = (
  // 创建并返回一个配置好的 MCP 服务器实例
  diffManager: DiffManager, // diff 管理器 (处理 diff 视图生命周期)
  log: (message: string) => void, // 日志函数
) => {
  const server = new McpServer( // 构造 MCP 服务器
    { name: 'gemini-cli-companion-mcp-server', version: '1.0.0' }, // 基本信息
    { capabilities: { logging: {} } }, // 能力声明 (支持 logging)
  );
  server.registerTool(
    // 注册 openDiff 工具
    'openDiff', // 工具名称
    {
      // 描述与输入 schema
      description:
        '(IDE Tool) Open a diff view to create or modify a file. Returns a notification once the diff has been accepted or rejcted.',
      inputSchema: OpenDiffRequestSchema.shape, // 输入参数结构
    },
    async ({ filePath, newContent }: z.infer<typeof OpenDiffRequestSchema>) => {
      // 执行函数
      log(`Received openDiff request for filePath: ${filePath}`); // 记录调用日志
      await diffManager.showDiff(filePath, newContent); // 显示 diff 视图
      return { content: [] }; // 返回空内容 (通知由异步事件触发)
    },
  );
  server.registerTool(
    // 注册 closeDiff 工具
    'closeDiff', // 工具名称
    {
      description: '(IDE Tool) Close an open diff view for a specific file.', // 描述
      inputSchema: CloseDiffRequestSchema.shape, // 输入结构
    },
    async ({
      filePath,
      suppressNotification,
    }: z.infer<typeof CloseDiffRequestSchema>) => {
      // 执行函数
      log(`Received closeDiff request for filePath: ${filePath}`); // 日志
      const content = await diffManager.closeDiff(
        filePath,
        suppressNotification,
      ); // 关闭 diff 获取内容
      const response = { content: content ?? undefined }; // 构建响应对象
      return {
        // 返回工具执行结果 (文本部件包含 JSON)
        content: [
          { type: 'text', text: JSON.stringify(response) }, // 以 JSON 字符串形式返回内容
        ],
      };
    },
  );
  return server; // 返回创建好的服务器实例
};
