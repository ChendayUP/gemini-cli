# Local Development ⚙️

## Running the Extension

To run the extension locally for development, we recommend using the automatic
watch process for continuous compilation:

1.  **Install Dependencies** (from the root of the repository):
    ```bash
    npm install
    ```
2.  **Open in VS Code:** Open this directory (`packages/vscode-ide-companion`)
    in your VS Code editor.
3.  **Start Watch Mode:** Run the watch script to compile the extension and
    monitor changes in both **esbuild** and **TypeScript**:
    ```bash
    npm run watch
    ```
4.  **Launch Host:** Press **`F5`** (or **`fn+F5`** on Mac) to open a new
    **Extension Development Host** window with the extension running.

### Manual Build

If you only need to compile the extension once without watching for changes:

```bash
npm run build
```

## Debugging & Breakpoints 🐞

如果按 F5 进入调试后发现断点无法命中（断点是空心，或显示“未验证”），通常是因为调试配置的
`outFiles` 没有指向实际构建输出，或者 source map 没正确包含源码。

我们已经做了以下调整来确保断点可用：

1. 在 `.vscode/launch.json` 中将 `outFiles` 改为指向 `dist/**/*.cjs` (以及任何
   `.js`)，并使用 `npm: watch` 作为 `preLaunchTask`。
2. 在 `esbuild.js` 中设置 `sourcesContent: true`，确保 source map 内嵌源码，VS
   Code 可以精确反向映射。
3. TypeScript `tsconfig.json` 已开启 `"sourceMap": true`。

### 正确的调试步骤

1. 终端或任务运行：`npm run watch`（会同时运行 esbuild 与类型检查）。
2. 在源码（`src/*.ts`）里打断点，比如 `src/extension.ts`。
3. 按 F5 使用 “Run Extension” 配置。VS Code 会启动 Extension Development Host。
4. 当扩展激活后（当前配置为
   `onStartupFinished`），断点应变为已验证并在执行路径中命中。

### 常见问题排查

| 问题         | 原因                          | 解决                                                            |
| ------------ | ----------------------------- | --------------------------------------------------------------- |
| 断点空心     | source map 未加载或路径不匹配 | 确认 `dist/extension.cjs.map` 存在；确认 `outFiles` 指向 `dist` |
| 断点不触发   | 代码未执行或激活事件未触发    | 激活事件是 `onStartupFinished`，确保 Extension Host 完全启动    |
| 命中位置偏移 | 打包合并导致映射偏差          | 确认未使用 `--production`（生产模式会最小化代码）               |
| 仍不工作     | 缓存或旧 bundle               | 停止调试，删除 `dist/`，重新运行 `npm run watch` 后再 F5        |

### 提示

如果要调试 Vitest 测试逻辑，建议直接使用
`npm test`（Vitest 自身也支持 IDE 断点，通过添加独立的 Node attach 配置）。当前
`esbuild` 仅构建入口 `src/extension.ts`，测试不会被打包进 `dist`。

如仍有问题，可在命令面板运行 “Toggle Developer Tools” 查看控制台是否有加载错误。
