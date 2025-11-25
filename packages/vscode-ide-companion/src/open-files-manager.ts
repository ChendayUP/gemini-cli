/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 版权与许可信息注释块结束

import * as vscode from 'vscode'; // 导入 VS Code 扩展 API，用于监听编辑器事件、访问工作区状态等
import type {
  // 类型导入：仅编译期使用，避免运行时打包
  File, // File 类型：代表一个被跟踪的文件的元数据（路径、时间戳、是否激活、光标、选中文本等）
  IdeContext, // IdeContext 类型：扩展向 CLI 发送的 IDE 上下文结构（包含 openFiles 等）
} from '@google/gemini-cli-core/src/ide/types.js'; // 从核心包路径引入类型定义

export const MAX_FILES = 10; // 常量：最多跟踪最近活动的文件数量为 10，防止列表过长影响性能或上下文冗余
const MAX_SELECTED_TEXT_LENGTH = 16384; // 16 KiB limit // 常量：选中文本最大长度限制为 16384 字符，超过会被截断以防止上下文过大

/** // 类注释块开始
 * Keeps track of the workspace state, including open files, cursor position, and selected text. // 英文原注释：维护工作区状态（打开文件、光标、选择内容）
 */ // 类注释块结束
export class OpenFilesManager {
  // 定义 OpenFilesManager 类：负责收集并维护用户当前与最近操作的文件集合及其活动上下文
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>(); // 创建事件发射器：用于在状态变化时通知监听者（IDE Server）
  readonly onDidChange = this.onDidChangeEmitter.event; // 暴露事件：外部可订阅 onDidChange 获得更新信号
  private debounceTimer: NodeJS.Timeout | undefined; // 用于实现防抖的计时器引用，避免频繁事件触发造成性能浪费
  private openFiles: File[] = []; // 存储当前被跟踪的文件列表（按最近使用顺序，首元素为当前激活文件）

  constructor(private readonly context: vscode.ExtensionContext) {
    // 构造函数：注入扩展上下文用于注册 disposable 事件监听
    const editorWatcher = vscode.window.onDidChangeActiveTextEditor(
      // 注册监听：活动编辑器变化（切换标签或焦点变化）
      (editor) => {
        // 回调函数：收到新活动编辑器对象
        if (editor && this.isFileUri(editor.document.uri)) {
          // 检查编辑器存在且其文档 URI scheme 为 file（排除设置页等）
          this.addOrMoveToFront(editor); // 将该文件移动到列表前端或新增（并设为激活）
          this.fireWithDebounce(); // 触发防抖事件通知上下文更新
        } // if 结束
      }, // 回调结束
    ); // 活动编辑器监听注册结束

    const selectionWatcher = vscode.window.onDidChangeTextEditorSelection(
      // 注册监听：文本选择变化（光标移动或选区变更）
      (event) => {
        // 回调：提供编辑器与选区信息
        if (this.isFileUri(event.textEditor.document.uri)) {
          // 确认操作的仍是文件类型文档
          this.updateActiveContext(event.textEditor); // 更新当前激活文件的光标位置与选中文本内容
          this.fireWithDebounce(); // 发射防抖通知，稍后统一批量更新上下文
        } // if 结束
      }, // 回调结束
    ); // 文本选择监听注册结束

    const closeWatcher = vscode.workspace.onDidCloseTextDocument((document) => {
      // 注册监听：文档关闭事件（标签关闭或编辑器销毁）
      if (this.isFileUri(document.uri)) {
        // 若关闭的是一个文件 URI 类型文档
        this.remove(document.uri); // 从跟踪列表中移除该文件项
        this.fireWithDebounce(); // 触发一次防抖通知，更新上下文
      } // if 结束
    }); // 文档关闭监听注册结束

    const deleteWatcher = vscode.workspace.onDidDeleteFiles((event) => {
      // 注册监听：文件被物理删除事件（多文件批量删除）
      for (const uri of event.files) {
        // 遍历所有被删除的文件 URI
        if (this.isFileUri(uri)) {
          // 确认是文件类型 URI
          this.remove(uri); // 从内部列表移除对应项
        } // if 结束
      } // for 循环结束
      this.fireWithDebounce(); // 删除操作完成后触发防抖事件以更新上下文
    }); // 文件删除监听注册结束

    const renameWatcher = vscode.workspace.onDidRenameFiles((event) => {
      // 注册监听：文件重命名事件（支持批量）
      for (const { oldUri, newUri } of event.files) {
        // 遍历所有重命名对（旧 URI 与新 URI）
        if (this.isFileUri(oldUri)) {
          // 如果旧 URI 是文件类型（我们原本可能在跟踪它）
          if (this.isFileUri(newUri)) {
            // 新 URI 仍然是文件类型（正常重命名）
            this.rename(oldUri, newUri); // 更新内部列表中该文件的路径到新路径
          } else {
            // 新 URI 不是文件类型（可能被移动到特殊 scheme，视为不再跟踪）
            // The file was renamed to a non-file URI, so we should remove it. // 英文原注释：被重命名到非 file，应删除
            this.remove(oldUri); // 从列表中移除旧文件条目
          } // if newUri 判断结束
        } // if oldUri 判断结束
      } // for 循环结束
      this.fireWithDebounce(); // 重命名批处理完成后触发防抖通知
    }); // 文件重命名监听注册结束

    context.subscriptions.push(
      // 将所有监听器 Disposable 推入扩展上下文的 subscriptions，便于扩展卸载时自动清理
      editorWatcher, // 活动编辑器变化监听器
      selectionWatcher, // 文本选择变化监听器
      closeWatcher, // 文档关闭监听器
      deleteWatcher, // 文件删除监听器
      renameWatcher, // 文件重命名监听器
    ); // push 操作结束

    // Just add current active file on start-up. // 英文原注释：启动时若已有活动文件则也加入跟踪
    if (
      // 条件判断开始
      vscode.window.activeTextEditor && // 当前是否存在活动编辑器
      this.isFileUri(vscode.window.activeTextEditor.document.uri) // 且该编辑器对应文档是 file scheme
    ) {
      // 条件成立块开始
      this.addOrMoveToFront(vscode.window.activeTextEditor); // 将其加入跟踪列表并设为激活
    } // 条件结束
  } // 构造函数结束

  private isFileUri(uri: vscode.Uri): boolean {
    // 辅助方法：判断 URI 是否为普通文件（scheme === 'file'）
    return uri.scheme === 'file'; // 返回布尔结果，true 表示应该跟踪
  } // isFileUri 方法结束

  private addOrMoveToFront(editor: vscode.TextEditor) {
    // 将指定编辑器对应文件加入列表前端（作为当前激活），若已存在则先移除旧位置
    // Deactivate previous active file // 英文原注释：取消之前激活的文件状态
    const currentActive = this.openFiles.find((f) => f.isActive); // 查找当前标记为 isActive 的文件对象
    if (currentActive) {
      // 若找到之前的活动文件
      currentActive.isActive = false; // 取消其活动标记
      currentActive.cursor = undefined; // 清除光标信息（仅对激活文件维护）
      currentActive.selectedText = undefined; // 清除选中文本内容
    } // if 结束

    // Remove if it exists // 英文原注释：如果将要加入的文件已存在则先移除
    const index = this.openFiles.findIndex(
      // 在数组中查找该文件是否已被跟踪
      (f) => f.path === editor.document.uri.fsPath, // 比较文件系统路径是否相等
    ); // findIndex 调用结束
    if (index !== -1) {
      // 如果找到了其索引（说明之前出现过）
      this.openFiles.splice(index, 1); // 从原位置移除该元素
    } // if 结束

    // Add to the front as active // 英文原注释：将其添加到列表头部并标记活动
    this.openFiles.unshift({
      // 使用 unshift 在数组前端插入新对象
      path: editor.document.uri.fsPath, // path：文件绝对路径
      timestamp: Date.now(), // timestamp：记录加入时间（可用于排序或淘汰策略）
      isActive: true, // isActive：标记当前为活动文件
    }); // 插入对象结束

    // Enforce max length // 英文原注释：强制限制最大跟踪数量
    if (this.openFiles.length > MAX_FILES) {
      // 若超过预设的最大文件数
      this.openFiles.pop(); // 移除末尾（最旧）文件条目，维持队列长度
    } // if 结束

    this.updateActiveContext(editor); // 更新当前激活文件的光标与选区信息
  } // addOrMoveToFront 方法结束

  private remove(uri: vscode.Uri) {
    // 移除指定 URI 对应的文件条目
    const index = this.openFiles.findIndex((f) => f.path === uri.fsPath); // 查找该文件在数组中的索引
    if (index !== -1) {
      // 若存在
      this.openFiles.splice(index, 1); // 使用 splice 删除该元素
    } // if 结束
  } // remove 方法结束

  private rename(oldUri: vscode.Uri, newUri: vscode.Uri) {
    // 重命名：更新跟踪列表中旧路径对应的记录为新路径
    const index = this.openFiles.findIndex((f) => f.path === oldUri.fsPath); // 查找旧路径在列表中的位置
    if (index !== -1) {
      // 若找到
      this.openFiles[index].path = newUri.fsPath; // 更新其 path 字段为新的文件系统路径
    } // if 结束
  } // rename 方法结束

  private updateActiveContext(editor: vscode.TextEditor) {
    // 更新当前活动文件的动态上下文（光标位置与选中文本）
    const file = this.openFiles.find(
      // 查找当前编辑器对应的文件记录
      (f) => f.path === editor.document.uri.fsPath, // 匹配文件系统路径
    ); // find 调用结束
    if (!file || !file.isActive) {
      // 若未找到或该文件并非当前激活
      return; // 不做任何更新直接返回
    } // if 结束

    file.cursor = editor.selection.active // 根据编辑器选区的 active（光标位置）设置 cursor 信息
      ? {
          // 若存在 active（一般都存在）
          line: editor.selection.active.line + 1, // 行号：使用 1 基础计数（内部是 0 基）因此 +1
          character: editor.selection.active.character, // 列号：直接使用 VS Code 提供的字符索引
        } // 对象结束
      : undefined; // 若不存在则设为 undefined

    let selectedText: string | undefined = // 定义选中文本变量，可能为空
      editor.document.getText(editor.selection) || undefined; // 使用 VS Code API 获取选区文本，没有则返回空字符串再转为 undefined
    if (selectedText && selectedText.length > MAX_SELECTED_TEXT_LENGTH) {
      // 若选中文本存在且长度超出上限
      selectedText = // 对选中文本进行截断处理
        selectedText.substring(0, MAX_SELECTED_TEXT_LENGTH) + '... [TRUNCATED]'; // 截取前 16384 字符并添加截断提示尾部标记
    } // if 截断判断结束
    file.selectedText = selectedText; // 将最终选中文本（可能截断或 undefined）写入 file 记录
  } // updateActiveContext 方法结束

  private fireWithDebounce() {
    // 防抖触发：避免频繁事件（光标移动、快速切换）导致大量通知
    if (this.debounceTimer) {
      // 若之前已有定时器存在
      clearTimeout(this.debounceTimer); // 清除它，重新计时（实现防抖）
    } // if 结束
    this.debounceTimer = setTimeout(() => {
      // 重新设置一个 50ms 的延时定时器
      this.onDidChangeEmitter.fire(); // 到时间后发射一次状态变化事件
    }, 50); // 50ms // 延迟时间选择较短，确保体验实时性同时避免抖动
  } // fireWithDebounce 方法结束

  get state(): IdeContext {
    // 公开 getter：生成当前 IDE 上下文对象（供外部广播到 CLI）
    return {
      // 返回对象符合 IdeContext 类型结构
      workspaceState: {
        // workspaceState 字段：包含工作区相关动态状态
        openFiles: [...this.openFiles], // openFiles：克隆数组（扩展副本避免外部修改内部状态）
        isTrusted: vscode.workspace.isTrusted, // isTrusted：工作区是否被 VS Code 标记为可信（影响某些操作安全限制）
      }, // workspaceState 对象结束
    }; // 返回结束
  } // state getter 结束
} // OpenFilesManager 类结束
