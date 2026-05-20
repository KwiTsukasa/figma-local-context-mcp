# Figma Local Context MCP

一个本地 `.fig` 文件 MCP Server。它结合了当前项目里的 `.fig` 解码、节点 SVG/PNG 导出能力，以及 `GLips/Figma-Context-MCP` 的 MCP 工具注册方式。

这个项目不依赖 Figma REST API，也不需要 `FIGMA_API_KEY`。MCP 客户端只需要传入本机 `.fig` 或 `.fig.json` 路径即可。

## 工具

- `get_design_context`：官方 Figma MCP 风格的主入口，返回节点树、样式、tokens 和代码提示。
- `get_code_context`：返回更适合代码生成的布局、样式和导出资源提示。
- `export_assets`：批量导出多个节点为 SVG 或 PNG。
- `list_fig_nodes`：按名称、类型或 node-id 搜索节点。
- `get_design_tokens`：从全文件或指定节点子树中推导颜色、渐变、阴影、描边 token。
- `inspect_fig_file`：读取本地 `.fig`，返回节点数量、类型统计和节点概览。
- `get_fig_node`：按节点名、`2625:12945`、`2625-12945`、`node-id=2625-12945` 或完整 Figma 链接查找节点，并返回简化上下文。
- `export_fig_node`：把指定节点导出为 SVG 或 PNG，PNG 支持倍率。

## 示例参数

获取官方风格设计上下文：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "nodeQuery": "node-id=2625-12945",
  "depth": 2,
  "includeTokens": true,
  "includeCodeHints": true
}
```

获取代码生成上下文：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "nodeQuery": "2625-12945",
  "depth": 2
}
```

搜索节点：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "query": "Group 1321315187",
  "limit": 20
}
```

批量导出资源：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "nodeQueries": ["2625-12945", "Group 1321315187"],
  "outputDir": "D:\\MyFiles\\Download\\fig-export-debug\\assets",
  "format": "png",
  "scale": 2
}
```

获取设计 token：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "nodeQuery": "2625-12945"
}
```

底层文件概览：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "maxNodes": 20
}
```

底层单节点查询：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "nodeQuery": "node-id=2625-12945",
  "depth": 1
}
```

底层单节点导出：

```json
{
  "filePath": "D:\\MyFiles\\Download\\兴泰安全生产预计平台-朱梓鑫.fig",
  "nodeQuery": "2625-12945",
  "outputPath": "D:\\MyFiles\\Download\\fig-export-debug\\mcp-export-node.png",
  "format": "png",
  "scale": 2
}
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
```

本地调试：

```bash
pnpm dev
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "Figma Local Context": {
      "command": "cmd",
      "args": ["/c", "pnpm", "--dir", "D:\\MyFiles\\Codes\\Node\\figma-local-context-mcp", "dev"]
    }
  }
}
```

构建后也可以使用：

```json
{
  "mcpServers": {
    "Figma Local Context": {
      "command": "cmd",
      "args": ["/c", "node", "D:\\MyFiles\\Codes\\Node\\figma-local-context-mcp\\dist\\bin.js", "--stdio"]
    }
  }
}
```

## 引用与致谢

本项目在实现过程中参考并复用了以下开源项目的思路或能力：

- [GLips/Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP)：参考它的 MCP Server 组织方式、工具注册结构和官方 Figma MCP 风格的上下文输出思路。该仓库根目录提供 MIT License，`package.json` 也声明为 MIT。
- [yagudaev/figma-to-json](https://github.com/yagudaev/figma-to-json)：参考它对 `.fig` 文件读写和解码的实现方向，并在本项目中继续扩展本地节点检索、SVG/PNG 导出和 MCP 上下文能力。该仓库根 `package.json` 声明 `license: MIT`；当前主分支没有单独的根 LICENSE 文件。

## 许可证兼容性

上面两个引用仓库均声明为 MIT 许可证。MIT 许可证允许使用、复制、修改、合并、发布、分发、再许可和销售软件副本，因此支持本项目的私有使用、商业使用、二次开发和发布。需要遵守的核心条件是：分发包含这些项目的代码或其重要部分时，应保留对应的版权声明和许可声明。

本项目同样使用 MIT License，见 [LICENSE](./LICENSE)。
