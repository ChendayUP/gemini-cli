/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 版权声明块结束

import {
  // 导入语句开始，用于引入所需类型/常量
  IdeDiffAcceptedNotificationSchema, // 从核心包导入“diff 被接受”通知的 zod 校验 Schema，用于构造并校验 JSON-RPC 通知数据结构
  IdeDiffClosedNotificationSchema, // 导入“diff 关闭”通知 Schema，表示用户关闭/取消 diff 后向 CLI 发送的事件数据结构
} from '@google/gemini-cli-core/src/ide/types.js'; // 指定模块路径：核心包中 IDE 类型定义文件
import { type JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js'; // 引入 JSONRPCNotification 类型，用于说明事件发送的结构（JSON-RPC 2.0 通知）
import * as path from 'node:path'; // 导入 Node.js path 模块，用于处理文件路径和提取文件名
import * as vscode from 'vscode'; // 导入 VS Code 扩展 API，操作编辑器、命令、事件等核心功能
import { DIFF_SCHEME } from './extension.js'; // 从当前扩展入口文件中导入自定义文档 scheme，用于右侧虚拟 diff 文档的 URI 构造

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  // 定义 DiffContentProvider 类，实现 VS Code 的内容提供者接口，用来动态提供“右侧修改后内容”
  private content = new Map<string, string>(); // 使用 Map 保存 URI 到文本内容的映射，保证可快速读写
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>(); // 创建事件发射器，当某个虚拟文档内容变更时通知 VS Code 刷新

  get onDidChange(): vscode.Event<vscode.Uri> {
    // 暴露只读事件属性，VS Code 会订阅它以便刷新对应文档
    return this.onDidChangeEmitter.event; // 返回内部事件对象
  } // getter 结束

  provideTextDocumentContent(uri: vscode.Uri): string {
    // VS Code 请求某个虚拟文档内容时调用此方法
    return this.content.get(uri.toString()) ?? ''; // 从 Map 中取出内容，若不存在则返回空字符串避免 undefined
  } // provideTextDocumentContent 方法结束

  setContent(uri: vscode.Uri, content: string): void {
    // 设置某个虚拟文档的内容并触发 UI 刷新
    this.content.set(uri.toString(), content); // 将 URI 字符串作为 key 存储新内容
    this.onDidChangeEmitter.fire(uri); // 发射变更事件，通知编辑器重新渲染该文档
  } // setContent 方法结束

  deleteContent(uri: vscode.Uri): void {
    // 删除某个虚拟文档对应的内容缓存
    this.content.delete(uri.toString()); // 从 Map 中移除记录，释放内存
  } // deleteContent 方法结束

  getContent(uri: vscode.Uri): string | undefined {
    // 直接获取内容（供外部逻辑使用）
    return this.content.get(uri.toString()); // 返回可能存在的文本或 undefined
  } // getContent 方法结束
} // DiffContentProvider 类结束

// Information about a diff view that is currently open. // 英文原始注释：描述单个打开的 diff 视图的信息结构
interface DiffInfo {
  // 定义 DiffInfo 接口，表示一个 diff 视图的元数据
  originalFilePath: string; // originalFilePath：左侧原始文件的绝对路径（真实存在或可能尚未创建）
  newContent: string; // newContent：右侧虚拟文档的初始内容（即建议的修改版本）
  rightDocUri: vscode.Uri; // rightDocUri：右侧虚拟文档的 URI（使用自定义 scheme 构造）
} // DiffInfo 接口结束

/** // 多行注释开始
 * Manages the state and lifecycle of diff views within the IDE. // 英文描述：管理 diff 视图的状态与生命周期
 */ // 多行注释结束
export class DiffManager {
  // 定义 DiffManager 类，负责创建、关闭、接受、取消 diff 以及向 CLI 发通知
  private readonly onDidChangeEmitter = // 创建发射器，发送 JSON-RPC 通知到外部（IDE Server 转发给 CLI）
    new vscode.EventEmitter<JSONRPCNotification>(); // 事件类型为 JSONRPCNotification（封装好的消息）
  readonly onDidChange = this.onDidChangeEmitter.event; // 暴露只读事件，外部可以订阅以获取 diff 状态变化通知
  private diffDocuments = new Map<string, DiffInfo>(); // 保存右侧虚拟文档 URI 字符串到 DiffInfo 的映射，用来管理多个 diff 实例
  private readonly subscriptions: vscode.Disposable[] = []; // 存储已注册的 VS Code 事件订阅，方便统一清理

  constructor(
    // 构造函数，注入日志函数及内容提供者实例
    private readonly log: (message: string) => void, // log 回调：记录调试或运行过程信息
    private readonly diffContentProvider: DiffContentProvider, // diffContentProvider：用于设置和删除右侧虚拟内容
  ) {
    // 构造函数体开始
    this.subscriptions.push(
      // 将事件监听的 disposable 对象放入数组以便释放
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // 监听活动编辑器变化事件，实时判断 diff 是否仍显示
        this.onActiveEditorChange(editor); // 调用内部方法更新上下文 gemini.diff.isVisible 状态
      }), // 事件订阅结束
    ); // push 完毕
    this.onActiveEditorChange(vscode.window.activeTextEditor); // 初始化时立即同步当前活动编辑器的 diff 可见状态
  } // 构造函数结束

  dispose() {
    // dispose 方法：释放所有事件订阅资源
    for (const subscription of this.subscriptions) {
      // 遍历存储的 disposable 列表
      subscription.dispose(); // 调用 dispose() 解除事件监听，防止内存泄漏
    } // for 循环结束
  } // dispose 方法结束

  /** // 注释：方法用途说明
   * Creates and shows a new diff view. // 创建并展示一个新的 diff 视图
   */ // 块注释结束
  async showDiff(filePath: string, newContent: string) {
    // showDiff：根据文件路径与新内容打开 diff（左原右新）
    const fileUri = vscode.Uri.file(filePath); // 将文件路径转换为 VS Code 支持的 file URI

    const rightDocUri = vscode.Uri.from({
      // 构造右侧虚拟文档 URI
      scheme: DIFF_SCHEME, // 使用自定义 scheme（如 gemini-diff）标识这是 diff 虚拟内容
      path: filePath, // 路径沿用原文件路径（便于显示与识别）
      // cache busting // 英文注释：避免缓存
      query: `rand=${Math.random()}`, // 添加随机查询参数使得每次 diff 打开都被视为唯一 URI，触发内容重新加载
    }); // URI 构造结束
    this.diffContentProvider.setContent(rightDocUri, newContent); // 通过内容提供者设置右侧虚拟文档初始内容

    this.addDiffDocument(rightDocUri, {
      // 将当前 diff 记录加入管理 Map
      originalFilePath: filePath, // 保存左侧原始文件路径
      newContent, // 保存新内容副本（可用于后续操作）
      rightDocUri, // 保存右侧文档 URI 引用
    }); // addDiffDocument 调用结束

    const diffTitle = `${path.basename(filePath)} ↔ Modified`; // 构造 diff 编辑器标题（使用文件名 + 箭头符号指示比较）
    await vscode.commands.executeCommand(
      // 执行 VS Code 命令设置上下文 key，供条件渲染 / 按钮显隐
      'setContext', // 命令：设置一个上下文变量
      'gemini.diff.isVisible', // 上下文键：表示当前是否存在一个 diff 视图被展示
      true, // 将状态置为 true（显示中）
    ); // executeCommand 结束

    let leftDocUri; // 定义左侧文档 URI 变量（真实文件或空文档）
    try {
      // 使用 try/catch 检测文件是否真实存在
      await vscode.workspace.fs.stat(fileUri); // 调用文件系统 stat，若成功表示文件存在
      leftDocUri = fileUri; // 若存在则直接使用 file URI 作为左侧
    } catch {
      // 捕获异常：文件不存在（例如新建拟议文件）
      // We need to provide an empty document to diff against. // 英文说明：需要一个空文档做比较
      // Using the 'untitled' scheme is one way to do this. // 解释：使用 untitled scheme 可以创建临时编辑器
      leftDocUri = vscode.Uri.from({
        // 构造一个未命名临时文档 URI
        scheme: 'untitled', // untitled scheme 允许编辑器展示一个未保存的空文件
        path: filePath, // 保留同路径名有助于用户识别该文件意图
      }); // URI 构造结束
    } // try/catch 结束

    await vscode.commands.executeCommand(
      // 执行 diff 打开命令
      'vscode.diff', // VS Code 内置命令：打开一个差异比较视图
      leftDocUri, // 左侧文档 URI（真实文件或空文档）
      rightDocUri, // 右侧虚拟文档 URI（建议修改内容）
      diffTitle, // 标题用于标签栏显示
      {
        // 额外配置对象
        preview: false, // 禁用预览模式，确保 tab 固定方便编辑
        preserveFocus: true, // 保留当前焦点（不强制切换到 diff），提高用户体验
      }, // 配置对象结束
    ); // diff 命令结束
    await vscode.commands.executeCommand(
      // 额外命令：允许右侧编辑器可写（默认虚拟文档可能只读）
      'workbench.action.files.setActiveEditorWriteableInSession', // 设置当前活动编辑器在会话中可写入
    ); // executeCommand 结束
  } // showDiff 方法结束

  /** // 方法说明注释块
   * Closes an open diff view for a specific file. // 关闭指定文件对应的 diff 视图
   */ // 注释结束
  async closeDiff(filePath: string, suppressNotification = false) {
    // closeDiff：关闭 diff（可选择是否发送关闭通知）
    let uriToClose: vscode.Uri | undefined; // 用于存放找到的右侧虚拟文档 URI
    for (const [uriString, diffInfo] of this.diffDocuments.entries()) {
      // 遍历所有已登记 diff 记录
      if (diffInfo.originalFilePath === filePath) {
        // 匹配目标文件路径
        uriToClose = vscode.Uri.parse(uriString); // 解析保存的字符串为 URI 对象
        break; // 找到后立即停止循环
      } // if 匹配结束
    } // for 循环结束

    if (uriToClose) {
      // 若找到了对应 diff 视图
      const rightDoc = await vscode.workspace.openTextDocument(uriToClose); // 打开右侧虚拟文档获取当前内容（用户可能已编辑）
      const modifiedContent = rightDoc.getText(); // 读取用户修改后的文本，用于通知返回
      await this.closeDiffEditor(uriToClose); // 调用内部方法关闭 diff 标签并清理状态
      if (!suppressNotification) {
        // 若没有被标记为抑制通知
        this.onDidChangeEmitter.fire(
          // 发送“diffClosed”通知给上游（CLI）
          IdeDiffClosedNotificationSchema.parse({
            // 使用 zod Schema 校验并构造通知数据结构
            jsonrpc: '2.0', // JSON-RPC 协议版本号
            method: 'ide/diffClosed', // 通知方法名：标识 diff 已关闭
            params: {
              // 参数对象开始
              filePath, // 文件路径：告诉 CLI 是哪一个文件的 diff 被关闭
              content: modifiedContent, // content：传出最终内容（可能在 UI 中被编辑过）
            }, // 参数对象结束
          }), // parse 完成得到强类型对象
        ); // fire 结束
      } // if suppressNotification 结束
      return modifiedContent; // 返回修改后的内容（供调用方可能使用）
    } // if uriToClose 结束
    return; // 未找到 diff 则返回 undefined（显式 return）
  } // closeDiff 方法结束

  /** // 注释块
   * User accepts the changes in a diff view. Does not apply changes. // 用户接受 diff 显示的修改（但并不自动写回磁盘）
   */ // 注释结束
  async acceptDiff(rightDocUri: vscode.Uri) {
    // acceptDiff：处理用户点击“接受”动作
    const diffInfo = this.diffDocuments.get(rightDocUri.toString()); // 根据右侧 URI 查找 diff 元数据
    if (!diffInfo) {
      // 若未找到（可能已被手动移除）
      return; // 直接返回，不执行后续操作
    } // if 结束

    const rightDoc = await vscode.workspace.openTextDocument(rightDocUri); // 打开虚拟文档获取最新内容
    const modifiedContent = rightDoc.getText(); // 读取文本内容（可能包含用户微调）
    await this.closeDiffEditor(rightDocUri); // 关闭 diff 编辑器并清理状态

    this.onDidChangeEmitter.fire(
      // 发送“diffAccepted”通知，表示用户认可建议的修改
      IdeDiffAcceptedNotificationSchema.parse({
        // 构造并校验通知对象
        jsonrpc: '2.0', // 协议版本
        method: 'ide/diffAccepted', // 方法名：diffAccepted 供 CLI 识别
        params: {
          // 参数对象开始
          filePath: diffInfo.originalFilePath, // filePath：被比较的原始文件路径
          content: modifiedContent, // content：用户最后看到并接受的文本内容
        }, // 参数对象结束
      }), // parse 完成
    ); // fire 调用结束
  } // acceptDiff 方法结束

  /** // 注释块
   * Called when a user cancels a diff view. // 用户取消 diff（例如关闭标签或点击“取消”）时的处理逻辑
   */ // 注释结束
  async cancelDiff(rightDocUri: vscode.Uri) {
    // cancelDiff：处理用户取消动作（与关闭类似但语义不同）
    const diffInfo = this.diffDocuments.get(rightDocUri.toString()); // 查找 diff 信息
    if (!diffInfo) {
      // 若未找到（可能已提前清理）
      await this.closeDiffEditor(rightDocUri); // 仍尝试关闭对应编辑器以防残留
      return; // 返回结束流程
    } // if 结束

    const rightDoc = await vscode.workspace.openTextDocument(rightDocUri); // 打开右侧虚拟文档
    const modifiedContent = rightDoc.getText(); // 获取当前文本（用户可能已修改）
    await this.closeDiffEditor(rightDocUri); // 关闭 diff 编辑器

    this.onDidChangeEmitter.fire(
      // 发送“diffClosed”通知（取消与关闭统一发送 diffClosed）
      IdeDiffClosedNotificationSchema.parse({
        // 使用关闭通知的 Schema 进行校验构造
        jsonrpc: '2.0', // 协议版本
        method: 'ide/diffClosed', // 方法名 diffClosed：上游 CLI 区分与 diffAccepted
        params: {
          // 参数对象开始
          filePath: diffInfo.originalFilePath, // filePath：原始文件路径
          content: modifiedContent, // content：最终内容（用于 CLI 决策是否应用）
        }, // 参数对象结束
      }), // parse 完成
    ); // fire 结束
  } // cancelDiff 方法结束

  private async onActiveEditorChange(editor: vscode.TextEditor | undefined) {
    // 内部方法：当活动编辑器变化时更新上下文状态（是否显示 diff）
    let isVisible = false; // 标记：当前是否有 diff 视图被激活或对应源文件在左侧显示
    if (editor) {
      // 若当前存在活动编辑器
      isVisible = this.diffDocuments.has(editor.document.uri.toString()); // 直接判断右侧 URI 是否在 diff 管理中
      if (!isVisible) {
        // 若不是右侧虚拟文档
        for (const document of this.diffDocuments.values()) {
          // 遍历所有 diff 记录检查是否匹配其原始文件路径
          if (document.originalFilePath === editor.document.uri.fsPath) {
            // 如果当前活动编辑器是左侧原始文件
            isVisible = true; // 标记为可见（仍在 diff 上下文中）
            break; // 跳出循环
          } // if 结束
        } // for 循环结束
      } // if !isVisible 结束
    } // if editor 结束
    await vscode.commands.executeCommand(
      // 更新 VS Code 上下文变量供菜单/按钮条件显示使用
      'setContext', // 命令名称：设置上下文键值
      'gemini.diff.isVisible', // 上下文键：diff 是否可见
      isVisible, // 设置为当前计算出的布尔值
    ); // executeCommand 结束
  } // onActiveEditorChange 方法结束

  private addDiffDocument(uri: vscode.Uri, diffInfo: DiffInfo) {
    // 内部方法：登记一个新的 diff 信息
    this.diffDocuments.set(uri.toString(), diffInfo); // 将右侧虚拟文档 URI 转为字符串作为 key 保存 diff 元数据
  } // addDiffDocument 方法结束

  private async closeDiffEditor(rightDocUri: vscode.Uri) {
    // 内部方法：真正执行关闭 diff 编辑器标签并清理缓存
    const diffInfo = this.diffDocuments.get(rightDocUri.toString()); // 获取对应的 diff 信息（可能为空）
    await vscode.commands.executeCommand(
      // 重置上下文：diff 不再可见
      'setContext', // 命令名称
      'gemini.diff.isVisible', // 上下文键
      false, // 设置为 false 表示关闭
    ); // executeCommand 结束

    if (diffInfo) {
      // 若存在 diff 元数据
      this.diffDocuments.delete(rightDocUri.toString()); // 从 Map 中移除记录
      this.diffContentProvider.deleteContent(rightDocUri); // 删除右侧虚拟内容，释放内存
    } // if diffInfo 结束

    // Find and close the tab corresponding to the diff view // 英文原注释：查找并关闭对应的标签页
    for (const tabGroup of vscode.window.tabGroups.all) {
      // 遍历所有标签组（可能拆分编辑器区域）
      for (const tab of tabGroup.tabs) {
        // 遍历组内每个标签项
        const input = tab.input as {
          // 强制断言 tab.input 结构（diff 视图输入包含 original/modified）
          modified?: vscode.Uri; // modified：右侧修改后文档 URI
          original?: vscode.Uri; // original：左侧原始文档 URI
        }; // 断言对象结束
        if (input && input.modified?.toString() === rightDocUri.toString()) {
          // 若找到 modified URI 与待关闭的右侧 URI 匹配
          await vscode.window.tabGroups.close(tab); // 调用 API 关闭该标签页
          return; // 结束方法（已关闭，不再继续搜索）
        } // if 匹配结束
      } // 内层 for 结束
    } // 外层 for 结束
  } // closeDiffEditor 方法结束
} // DiffManager 类结束
