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
- `get_fig_node`：按节点名、`1234:5678`、`1234-5678`、`node-id=1234-5678` 或完整 Figma 链接查找节点，并返回简化上下文。
- `export_fig_node`：把指定节点导出为 SVG 或 PNG，PNG 支持倍率，默认走本地 `figma-like` 渲染。它会在本 MCP 生成的 SVG 上对部分滤镜/内阴影做补偿后再用 `@resvg/resvg-js` 栅格化，目标是接近 Figma 在线端 PNG，但不等同于 Figma 原生 PNG 导出。

## 示例参数

获取官方风格设计上下文：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "nodeQuery": "node-id=1234-5678",
  "depth": 2,
  "includeTokens": true,
  "includeCodeHints": true
}
```

获取代码生成上下文：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "nodeQuery": "1234-5678",
  "depth": 2
}
```

搜索节点：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "query": "Primary Card",
  "limit": 20
}
```

批量导出资源：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "nodeQueries": ["1234-5678", "Primary Card"],
  "outputDir": "C:\\Users\\you\\Exports\\figma-local-context\\assets",
  "format": "png",
  "scale": 2
}
```

获取设计 token：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "nodeQuery": "1234-5678"
}
```

底层文件概览：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "maxNodes": 20
}
```

底层单节点查询：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "nodeQuery": "node-id=1234-5678",
  "depth": 1
}
```

底层单节点导出：

```json
{
  "filePath": "C:\\Users\\you\\Designs\\sample.fig",
  "nodeQuery": "1234-5678",
  "outputPath": "C:\\Users\\you\\Exports\\figma-local-context\\sample-node.png",
  "format": "png",
  "scale": 2,
  "pngRenderer": "figma-like"
}
```

导出结果中的 `renderer` 字段会标明导出管线：

- `local-svg`：直接写出本地解码生成的 SVG。
- `local-figma-like-resvg`：默认 PNG 管线。先生成带 Figma-like 滤镜补偿的本地 SVG，再用 `@resvg/resvg-js` 转 PNG。
- `local-svg-resvg`：普通预览 PNG 管线。先生成本地 SVG，再用 `@resvg/resvg-js` 转 PNG。Figma 在线端 PNG 使用自身渲染管线，不能假定它是在线 SVG 再转 PNG。

当前本地 SVG/PNG 管线支持 `.fig` 外层 zip 中的 `images/<hash>` 图片资源，会把 `IMAGE` 填充按真实图片、paint transform 和矢量路径裁切导出；如果本地文件缺少对应图片资源，会明确报出缺失的 IMAGE hash。线性/径向渐变、虚线描边和部分滤镜也会转换为 SVG 近似表达。

导出结果还会包含 `exportCapabilities`：

- `localSvg.supported: true`：支持从本地 `.fig` 解码生成 SVG。
- `localPng.supported: true`：支持把本地 SVG 栅格化成预览 PNG。
- `figmaLikePng.supported: true`：支持本地 Figma-like PNG 近似渲染，会对 Figma 原生 PNG 中更强的内阴影/透明边缘做补偿。
- `figmaNativePng.supported: false`：纯本地 `.fig` 解码无法调用 Figma 原生 PNG 渲染器；如果需要与 Figma 在线 PNG 像素级一致，需要接入 Figma 官方运行时/API/桌面端导出能力。

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
      "args": ["/c", "pnpm", "--dir", "C:\\path\\to\\figma-local-context-mcp", "dev"]
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
      "args": ["/c", "node", "C:\\path\\to\\figma-local-context-mcp\\dist\\bin.js", "--stdio"]
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
