/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 许可证块结束

import * as vscode from 'vscode'; // 导入 VS Code 扩展 API 提供的所有命名空间函数与类型
import { IDEServer } from './ide-server.js'; // 导入 IDE 服务器类, 用于启动内部 MCP HTTP 服务
import semver from 'semver'; // 导入 semver 库进行版本号比较
import { DiffContentProvider, DiffManager } from './diff-manager.js'; // 导入差异内容提供者与差异管理器
import { createLogger } from './utils/logger.js'; // 导入日志创建函数
import {
  // 解构导入 IDE 检测相关工具与类型
  detectIdeFromEnv, // 函数: 根据环境变量/进程信息检测当前 IDE
  IDE_DEFINITIONS, // 常量: 各 IDE 的定义集合
  type IdeInfo, // 类型: IDE 信息结构
} from '@google/gemini-cli-core/src/ide/detect-ide.js'; // 从核心包导入 IDE 检测模块

const CLI_IDE_COMPANION_IDENTIFIER = 'Google.gemini-cli-vscode-ide-companion'; // 市场扩展唯一标识 (用于安装/查询更新)
const INFO_MESSAGE_SHOWN_KEY = 'geminiCliInfoMessageShown'; // globalState 键名, 标记是否已展示首次安装提示
export const DIFF_SCHEME = 'gemini-diff'; // 自定义差异虚拟文档的 URI scheme (右侧修改内容)

// 托管环境集合: 在这些 IDE Surface 中扩展可能由平台自动安装/升级, 不需要用户提示
const MANAGED_EXTENSION_SURFACES: ReadonlySet<IdeInfo['name']> = new Set([
  // 创建只读集合
  IDE_DEFINITIONS.firebasestudio.name, // Firebase Studio IDE 名称
  IDE_DEFINITIONS.cloudshell.name, // Cloud Shell IDE 名称
]); // 集合结束

let ideServer: IDEServer; // 保存 IDE 服务器实例 (用于后续关闭)
let logger: vscode.OutputChannel; // 输出通道实例 (日志面板显示)
let log: (message: string) => void = () => {}; // 日志函数占位符 (激活前不输出)

/**                                   // 函数说明注释开始
 * 检查市场是否有新版本并在非托管环境提示用户更新 // 功能描述
 * @param context 扩展上下文对象                 // 参数说明
 * @param log 日志函数                           // 参数说明
 * @param isManagedExtensionSurface 是否托管环境  // 参数说明
 */ // 注释结束
async function checkForUpdates( // 异步函数声明: 检查更新
  context: vscode.ExtensionContext, // 扩展上下文, 提供 packageJSON 等
  log: (message: string) => void, // 日志函数, 只在特定条件输出
  isManagedExtensionSurface: boolean, // 是否托管环境标记
) {
  // 函数体开始
  try {
    // try 捕获错误
    const currentVersion = context.extension.packageJSON.version; // 当前扩展版本
    const response = await fetch(
      // 发起网络请求查询市场数据
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', // 市场 API 地址
      {
        // 请求配置对象开始
        method: 'POST', // 使用 POST 方法
        headers: {
          // 请求头对象
          'Content-Type': 'application/json', // 指定内容类型 JSON
          Accept: 'application/json;api-version=7.1-preview.1', // 指定接收 API 版本
        }, // headers 结束
        body: JSON.stringify({
          // 请求体, 序列化为字符串
          filters: [
            // 过滤条件数组开始
            {
              // 单个过滤对象
              criteria: [
                // 条件列表
                {
                  // 条件对象
                  filterType: 7, // filterType=7 表示按扩展名称过滤
                  value: CLI_IDE_COMPANION_IDENTIFIER, // 要查询的扩展唯一标识
                }, // 条件对象结束
              ], // criteria 数组结束
            }, // filters 单个对象结束
          ], // filters 数组结束
          flags: 946, // 请求标志 (控制返回字段组合)
        }), // body 对象结束
      }, // fetch 第二个参数结束
    ); // fetch 调用结束
    if (!response.ok) {
      // 如果响应不是 2xx
      log(`从市场获取最新版本失败: ${response.statusText}`); // 输出错误状态文本
      return; // 结束函数 (不再继续处理)
    } // if 结束
    const data = await response.json(); // 解析响应 JSON 数据
    const extension = data?.results?.[0]?.extensions?.[0]; // 安全链访问扩展数据对象
    const latestVersion = extension?.versions?.[0]?.version; // 获取最新版本 (按时间排序第一位)
    if (
      // 判断是否需要显示更新提示
      !isManagedExtensionSurface && // 必须是非托管环境
      latestVersion && // 最新版本存在
      semver.gt(latestVersion, currentVersion) // 最新版本号大于当前版本号
    ) {
      // 条件成立开始
      const selection = await vscode.window.showInformationMessage(
        // 弹出信息选择框
        `发现新版本 (${latestVersion}) 的 Gemini CLI Companion 扩展。`, // 信息文本内容
        '更新到最新版本', // 操作按钮标题
      ); // 显示消息结束
      if (selection === '更新到最新版本') {
        // 用户选择更新
        await vscode.commands.executeCommand(
          // 执行 VS Code 安装/更新扩展命令
          'workbench.extensions.installExtension', // 内置命令 ID
          CLI_IDE_COMPANION_IDENTIFIER, // 目标扩展标识符
        ); // executeCommand 调用结束
      } // if 用户选择结束
    } // 更新提示判断结束
  } catch (error) {
    // 捕获请求或逻辑错误
    const message = error instanceof Error ? error.message : String(error); // 标准化错误信息
    log(`检查扩展更新时出错: ${message}`); // 输出错误日志
  } // try-catch 结束
} // checkForUpdates 函数结束

/**                                   // activate 函数说明注释开始
 * 扩展激活入口 (由 activationEvents 触发)     // 功能描述
 * 负责: 创建输出通道 / 检查更新 / 注册命令 / 启动 IDE 服务器 / 同步环境变量 / 显示首次安装提示 // 详细职责
 * @param context 扩展上下文                    // 参数说明
 */ // 注释结束
export async function activate(context: vscode.ExtensionContext) {
  // activate 函数声明
  logger = vscode.window.createOutputChannel('Gemini CLI IDE Companion'); // 创建输出通道实例
  log = createLogger(context, logger); // 初始化日志函数 (开发模式或配置启用时输出)
  log('扩展已激活'); // 记录激活日志
  const isManagedExtensionSurface = MANAGED_EXTENSION_SURFACES.has(
    // 判断是否托管环境
    detectIdeFromEnv().name, // 获取当前 IDE 名称
  ); // has 调用结束
  checkForUpdates(context, log, isManagedExtensionSurface); // 异步检查扩展更新
  const diffContentProvider = new DiffContentProvider(); // 创建差异内容提供者实例
  const diffManager = new DiffManager(log, diffContentProvider); // 创建差异管理器实例
  context.subscriptions.push(
    // 将多个 Disposable 推入上下文用于自动清理
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // 监听文档关闭事件
      if (doc.uri.scheme === DIFF_SCHEME) {
        // 若关闭的是差异虚拟文档
        diffManager.cancelDiff(doc.uri); // 视为取消 diff (发送关闭通知)
      } // if 结束
    }), // 事件监听注册结束
    vscode.workspace.registerTextDocumentContentProvider(
      // 注册内容提供者
      DIFF_SCHEME, // scheme 名称
      diffContentProvider, // 提供者实例
    ), // 注册结束
    vscode.commands.registerCommand(
      // 注册接受差异命令
      'gemini.diff.accept', // 命令 ID (在 package.json 中声明)
      (uri?: vscode.Uri) => {
        // 命令执行回调 (可选传入目标 URI)
        const docUri = uri ?? vscode.window.activeTextEditor?.document.uri; // 使用传入或当前活动编辑器文档
        if (docUri && docUri.scheme === DIFF_SCHEME) {
          // 确认是差异虚拟文档
          diffManager.acceptDiff(docUri); // 调用接受逻辑 (发送 ide/diffAccepted 通知)
        } // if 结束
      }, // 回调结束
    ), // registerCommand 结束
    vscode.commands.registerCommand(
      // 注册取消差异命令
      'gemini.diff.cancel', // 命令 ID
      (uri?: vscode.Uri) => {
        // 执行回调
        const docUri = uri ?? vscode.window.activeTextEditor?.document.uri; // 获取目标文档 URI
        if (docUri && docUri.scheme === DIFF_SCHEME) {
          // 确认是差异虚拟文档
          diffManager.cancelDiff(docUri); // 调用取消逻辑 (发送 ide/diffClosed 通知)
        } // if 结束
      }, // 回调结束
    ), // registerCommand 结束
  ); // subscriptions.push 调用结束
  ideServer = new IDEServer(log, diffManager); // 创建 IDE 服务器实例
  try {
    // 尝试启动服务器
    await ideServer.start(context); // 启动 (随机端口 + 写文件 + 建立监听)
  } catch (err) {
    // 捕获启动错误
    const message = err instanceof Error ? err.message : String(err); // 标准化错误信息
    log(`启动 IDE 服务器失败: ${message}`); // 输出错误日志
  } // try-catch 结束
  if (
    // 判断是否需要首次安装提示
    !context.globalState.get(INFO_MESSAGE_SHOWN_KEY) && // 尚未展示过
    !isManagedExtensionSurface // 且非托管环境
  ) {
    // 条件成立
    void vscode.window.showInformationMessage(
      'Gemini CLI Companion 扩展已成功安装。',
    ); // 弹出信息
    context.globalState.update(INFO_MESSAGE_SHOWN_KEY, true); // 更新状态避免重复提示
  } // if 结束
  context.subscriptions.push(
    // 注册与工作区相关的事件和其他命令
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // 工作区文件夹改变事件
      ideServer.syncEnvVars(); // 同步端口与工作区路径到环境变量文件
    }), // 监听结束
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      // 工作区信任事件
      ideServer.syncEnvVars(); // 同步环境变量 (信任状态可能影响行为)
    }), // 监听结束
    vscode.commands.registerCommand('gemini-cli.runGeminiCLI', async () => {
      // 注册运行 CLI 命令
      const workspaceFolders = vscode.workspace.workspaceFolders; // 获取当前工作区文件夹
      if (!workspaceFolders || workspaceFolders.length === 0) {
        // 若没有打开任何文件夹
        vscode.window.showInformationMessage(
          '未打开文件夹, 请先打开后再运行 Gemini CLI222',
        ); // 提示用户
        return; // 退出命令执行
      } // if 结束
      let selectedFolder: vscode.WorkspaceFolder | undefined; // 选定的文件夹变量
      if (workspaceFolders.length === 1) {
        // 若只有一个文件夹
        selectedFolder = workspaceFolders[0]; // 直接选用
      } else {
        // 多文件夹场景
        selectedFolder = await vscode.window.showWorkspaceFolderPick({
          // 弹出选择器
          placeHolder: '选择要运行 Gemini CLI 的文件夹', // 占位符文本
        }); // showWorkspaceFolderPick 结束
      } // if-else 结束
      if (selectedFolder) {
        // 若用户选定文件夹
        const geminiCmd = 'gemini'; // CLI 命令名称 (假定已安装到 PATH)
        const terminal = vscode.window.createTerminal({
          // 创建新终端
          name: `Gemini CLI (${selectedFolder.name})`, // 终端显示名称
          cwd: selectedFolder.uri.fsPath, // 设置终端工作目录为选定文件夹路径
        }); // createTerminal 结束
        terminal.show(); // 显示终端面板
        terminal.sendText(geminiCmd); // 在终端发送命令启动 CLI
      } // if 结束
    }), // registerCommand 结束
    vscode.commands.registerCommand('gemini-cli.showNotices', async () => {
      // 注册显示第三方声明命令
      const noticePath = vscode.Uri.joinPath(
        // 构建扩展内 NOTICES.txt 文件路径 URI
        context.extensionUri, // 扩展根目录 URI
        'NOTICES.txt', // 文件名
      ); // joinPath 结束
      await vscode.window.showTextDocument(noticePath); // 打开文件显示内容
    }), // registerCommand 结束
  ); // subscriptions.push 结束
} // activate 函数结束

/**                                           // deactivate 函数说明注释开始
 * 扩展停用入口 (窗口关闭/禁用扩展时调用)       // 功能描述
 * 负责: 停止 IDE 服务器并清理输出通道            // 职责说明
 */ // 注释结束
export async function deactivate(): Promise<void> {
  // 异步停用函数声明
  log('扩展已停用'); // 记录停用日志
  try {
    // try 捕获停止错误
    if (ideServer) {
      // 如果服务器实例存在
      await ideServer.stop(); // 调用停止方法 (关闭监听/删除临时文件)
    } // if 结束
  } catch (err) {
    // 捕获停止错误
    const message = err instanceof Error ? err.message : String(err); // 标准化错误信息
    log(`停用时停止 IDE 服务器失败: ${message}`); // 输出错误日志
  } finally {
    // finally 清理资源
    if (logger) {
      // 如果输出通道存在
      logger.dispose(); // 释放输出通道资源
    } // if 结束
  } // try-catch-finally 结束
} // deactivate 函数结束
