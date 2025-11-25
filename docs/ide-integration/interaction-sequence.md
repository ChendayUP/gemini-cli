# Gemini CLI IDE Companion 交互时序图

本文档展示 VS Code 扩展与本地 IDE
Server、CLI 以及 Diff 管理与文件上下文跟踪之间的核心交互流程。所有步骤均基于当前实现的
`extension.ts`、`ide-server.ts`、`diff-manager.ts`、`open-files-manager.ts`。

## 场景 1：扩展激活与服务器启动

```mermaid
sequenceDiagram
    participant U as 用户
    participant VS as VS Code 扩展 (extension.ts)
    participant IS as IDE Server (ide-server.ts)
    participant OFM as OpenFilesManager
    participant DM as DiffManager
    participant CLI as gemini-cli (外部进程)

    U->>VS: 安装/启动 VS Code
    VS->>VS: activate() 初始化 OutputChannel / Logger
    VS->>OFM: 创建实例并收集当前活动文件
    VS->>DM: 创建 DiffContentProvider & DiffManager
    VS->>IS: new IDEServer(diffManager, openFilesManager)
    VS->>IS: server.start()
    IS->>IS: 生成随机 token / 绑定本地端口 / 写入端口与 workspacePath 文件
    IS-->>VS: 返回 { port, workspacePath }
    VS->>VS: setContext gemini-cli.workspace.open=true
    VS-->>CLI: (等待 CLI 后续读取端口与路径并连接)
```

## 场景 2：CLI 连接并获取 IDE 上下文

```mermaid
sequenceDiagram
    participant CLI as gemini-cli
    participant IS as IDE Server
    participant OFM as OpenFilesManager

    CLI->>IS: HTTP GET /keep-alive (携带 Bearer Token)
    IS-->>CLI: 200 OK { version }
    CLI->>IS: WebSocket /stream (MCP 传输建立)
    IS->>OFM: 读取 state (openFiles + isTrusted)
    IS-->>CLI: MCP Notification ide/contextUpdate(workspaceState)
```

## 场景 3：用户编辑 / 光标 / 选区变更触发上下文更新

```mermaid
sequenceDiagram
    participant U as 用户
    participant VS as VS Code 编辑器
    participant OFM as OpenFilesManager
    participant IS as IDE Server
    participant CLI as gemini-cli

    U->>VS: 切换活动文件 / 移动光标 / 修改选区
    VS->>OFM: 事件 onDidChangeActiveTextEditor / onDidChangeTextEditorSelection
    OFM->>OFM: 更新 openFiles[0].cursor / selectedText (截断 >16KiB)
    OFM->>OFM: 防抖 50ms 聚合变化
    OFM-->>IS: onDidChange 触发
    IS->>OFM: 拉取最新 state()
    IS-->>CLI: MCP Notification ide/contextUpdate(workspaceState)
```

## 场景 4：CLI 请求打开 Diff（代码建议）

```mermaid
sequenceDiagram
    participant CLI as gemini-cli (MCP 客户端)
    participant IS as IDE Server (MCP 服务器)
    participant DM as DiffManager
    participant VS as VS Code 编辑器

    CLI->>IS: MCP Tool 调用 openDiff { filePath, content }
    IS->>DM: diffManager.showDiff(filePath, content)
    DM->>DM: 构造右侧虚拟文档 URI (scheme=gemini-diff + 随机 query)
    DM->>VS: vscode.diff(leftFile, rightVirtualDoc)
    DM->>VS: setContext gemini.diff.isVisible=true
    VS-->>CLI: Tool 调用结果 { opened: true }
```

## 场景 5：用户在 Diff 中编辑并接受修改

```mermaid
sequenceDiagram
    participant U as 用户
    participant VS as VS Code Diff 编辑器
    participant DM as DiffManager
    participant IS as IDE Server
    participant CLI as gemini-cli

    U->>VS: 在右侧虚拟文档修改内容
    U->>VS: 触发命令 gemini.diff.accept
    VS->>DM: diffManager.acceptDiff(rightDocUri)
    DM->>VS: 关闭 Diff 标签 / 清理缓存
    DM-->>IS: onDidChangeEmitter 发送 ide/diffAccepted { filePath, content }
    IS-->>CLI: MCP Notification ide/diffAccepted
    CLI->>CLI: 决策是否写回文件 (外部逻辑)
```

## 场景 6：用户取消或直接关闭 Diff

```mermaid
sequenceDiagram
    participant U as 用户
    participant VS as VS Code Diff 编辑器
    participant DM as DiffManager
    participant IS as IDE Server
    participant CLI as gemini-cli

    U->>VS: 关闭 diff 编辑器 或 执行 gemini.diff.cancel
    VS->>DM: diffManager.cancelDiff(rightDocUri)
    DM->>VS: 关闭标签 / 清理 Map
    DM-->>IS: ide/diffClosed { filePath, content }
    IS-->>CLI: MCP Notification ide/diffClosed
    CLI->>CLI: 可忽略或记录最终用户编辑内容
```

## 场景 7：CLI 发起写文件操作（外部逻辑，可选）

```mermaid
sequenceDiagram
    participant CLI as gemini-cli
    participant IS as IDE Server
    participant FS as 文件系统
    participant VS as VS Code

    CLI->>IS: HTTP POST /write-file { path, content } (授权 Header)
    IS->>FS: 写入磁盘内容
    IS-->>CLI: { status: success }
    VS->>VS: (文件变更事件触发 -> 可被其它监听器处理)
```

## 组件职责概述 (中文速览)

- VS Code 扩展 (`extension.ts`): 负责初始化、注册命令、启动本地 IDE
  Server、协调 Diff 与上下文广播。
- IDE Server (`ide-server.ts`): 基于 Express +
  MCP，暴露工具 (openDiff/closeDiff)，广播 ide/contextUpdate、diffAccepted/diffClosed 等通知。
- DiffManager: 管理 diff 虚拟文档生命周期，用户接受/取消后发射通知。
- OpenFilesManager: 跟踪最近活动文件、光标、选区（带截断），防抖聚合后触发上下文更新。
- CLI (`gemini-cli`): 连接 IDE
  Server，消费上下文通知，调用工具生成/关闭 diff，基于用户反馈执行写回等操作。

## 关键交互要点

1. 身份验证：HTTP 请求需 Bearer Token（随机 UUID）确保仅本地受信进程访问。
2. 上下文同步：OpenFilesManager 防抖输出，IDE
   Server 拉取并广播，CLI 持有最新工作区状态用于生成建议。
3. Diff 机制：右侧虚拟文档使用自定义 scheme + 随机 query 避免缓存；关闭或接受差异时都提供最终内容回传。
4. 选区截断：超过 16KiB 选中文本自动截断并加尾标识，避免上下文过大影响模型性能或传输。
5. 条件日志：仅在开发模式或用户开启 debug 配置时输出，保证生产环境整洁。

---

如需补充“错误处理流程”或“并发/冲突”场景的时序图，请继续说明，我可以再添加扩展章节。
