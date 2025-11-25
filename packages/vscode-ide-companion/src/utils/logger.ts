/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 版权信息注释块结束

import * as vscode from 'vscode'; // 导入 VS Code API，用于访问扩展上下文与工作区配置

export function createLogger( // 导出函数：用于创建一个条件日志记录器
  context: vscode.ExtensionContext, // 参数 context：扩展上下文，包含运行模式等信息
  logger: vscode.OutputChannel, // 参数 logger：VS Code 输出通道，用于实际写入日志文本
) {
  // 函数体开始
  return (message: string) => {
    // 返回一个闭包函数：接收单条日志消息字符串
    const isDevMode = // 计算是否处于开发模式（扩展在本地调试状态）
      context.extensionMode === vscode.ExtensionMode.Development; // 比较扩展运行模式与 Development 枚举值
    const isLoggingEnabled = vscode.workspace // 读取工作区配置项以决定是否启用日志输出
      .getConfiguration('gemini-cli.debug') // 获取命名空间 gemini-cli.debug 下的配置组
      .get('logging.enabled'); // 读取具体键 logging.enabled（可能返回 true/false/undefined）

    if (isDevMode || isLoggingEnabled) {
      // 条件判断：开发模式 或 用户显式开启日志
      logger.appendLine(message); // 写入一行日志到输出通道（自动换行）
    } // if 结束
  }; // 闭包函数结束并返回给调用方使用
} // createLogger 函数结束
