import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { exportFigNode } from "../services/export-node.js"
import {
  exportAssets,
  getCodeContext,
  getDesignContext,
  getDesignTokens,
  listFigNodes
} from "../services/design-context.js"
import { getFigNodeContext, inspectFigFile } from "../services/fig-file.js"
import { getMakeContext } from "../services/fig-make.js"

const serverInfo = {
  name: "Figma Local Context MCP",
  version: process.env.NPM_PACKAGE_VERSION ?? "0.1.0",
  description:
    "Read local .fig files, inspect node context, export local SVG, and render Figma-like PNGs without Figma API/native renderer."
}

const inspectParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  maxNodes: z.number().int().positive().max(2000).default(200).describe("最多返回多少个节点摘要。")
})

const getNodeParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  nodeQuery: z
    .string()
    .min(1)
    .describe("节点名称、2625:12945、2625-12945、node-id=2625-12945 或完整 Figma 链接。"),
  depth: z.number().int().min(0).max(10).default(2).describe("返回节点子树的深度。")
})

const exportNodeParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  nodeQuery: z
    .string()
    .min(1)
    .describe("节点名称、2625:12945、2625-12945、node-id=2625-12945 或完整 Figma 链接。"),
  outputPath: z.string().min(1).optional().describe("输出文件路径；不传时写到当前工作目录。"),
  format: z.enum(["svg", "png"]).default("png").describe("导出格式；png 默认使用本地 figma-like 渲染。"),
  scale: z.number().positive().max(10).default(2).describe("导出倍率，PNG 预览常用 1/2/3/4。"),
  background: z.string().optional().describe("可选背景色，例如 #ffffff。"),
  pngRenderer: z
    .enum(["figma-like", "local-preview"])
    .default("figma-like")
    .describe("PNG 渲染器：figma-like 会增强滤镜/内阴影以接近 Figma PNG；local-preview 是普通 SVG 栅格化。")
})

const listNodesParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  query: z.string().optional().describe("按节点名、类型或 node-id 片段搜索。"),
  type: z.string().optional().describe("按 Figma 节点类型过滤，例如 FRAME、TEXT、VECTOR。"),
  limit: z.number().int().positive().max(5000).default(200).describe("最多返回多少个节点。"),
  includeHidden: z.boolean().default(false).describe("是否包含 visible=false 的节点。")
})

const designContextParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  nodeQuery: z
    .string()
    .optional()
    .describe("节点名称、2625:12945、2625-12945、node-id=2625-12945 或完整 Figma 链接；不传则返回文档根节点上下文。"),
  depth: z.number().int().min(0).max(8).default(2).describe("返回节点子树的深度。"),
  includeTokens: z.boolean().default(true).describe("是否附带从当前子树推导出的设计 token。"),
  includeCodeHints: z.boolean().default(true).describe("是否附带代码实现提示。")
})

const codeContextParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  nodeQuery: z
    .string()
    .min(1)
    .describe("节点名称、2625:12945、2625-12945、node-id=2625-12945 或完整 Figma 链接。"),
  depth: z.number().int().min(0).max(8).default(2).describe("返回代码提示子树的深度。")
})

const makeContextParams = z.object({
  filePath: z.string().min(1).describe("本地 Figma Make .make、.fig 或 .fig.json 文件路径。"),
  includeSource: z.boolean().default(false).describe("是否在结果中包含 CODE_FILE 源码内容。"),
  sourceMaxLength: z.number().int().min(0).max(200000).default(20000).describe("每个源码文件最多返回多少字符。"),
  fileQuery: z.string().optional().describe("按源码文件名、路径、语言或 node-id 过滤 CODE_FILE。"),
  includeAiChat: z.boolean().default(true).describe("是否返回 ai_chat.json 的线程和消息摘要。"),
  maxMessages: z.number().int().min(0).max(200).default(20).describe("每个 AI 线程最多返回多少条消息摘要。")
})

const exportAssetsParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  nodeQueries: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe("要导出的节点名或 node-id 列表。"),
  outputDir: z.string().min(1).describe("资源输出目录。"),
  format: z.enum(["svg", "png"]).default("png").describe("导出格式；png 默认使用本地 figma-like 渲染。"),
  scale: z.number().positive().max(10).default(2).describe("导出倍率，PNG 预览常用 1/2/3/4。"),
  background: z.string().optional().describe("可选背景色，例如 #ffffff。"),
  pngRenderer: z
    .enum(["figma-like", "local-preview"])
    .default("figma-like")
    .describe("PNG 渲染器：figma-like 会增强滤镜/内阴影以接近 Figma PNG；local-preview 是普通 SVG 栅格化。")
})

const designTokensParams = z.object({
  filePath: z.string().min(1).describe("本地 .fig 或 .fig.json 文件路径。"),
  nodeQuery: z.string().optional().describe("可选节点范围；不传则从文档根节点提取。")
})

type InspectParams = z.infer<typeof inspectParams>
type GetNodeParams = z.infer<typeof getNodeParams>
type ExportNodeParams = z.infer<typeof exportNodeParams>
type ListNodesParams = z.infer<typeof listNodesParams>
type DesignContextParams = z.infer<typeof designContextParams>
type CodeContextParams = z.infer<typeof codeContextParams>
type MakeContextParams = z.infer<typeof makeContextParams>
type ExportAssetsParams = z.infer<typeof exportAssetsParams>
type DesignTokensParams = z.infer<typeof designTokensParams>

export function createServer(): McpServer {
  const server = new McpServer(serverInfo)

  server.registerTool(
    "list_fig_nodes",
    {
      title: "List local Figma nodes",
      description: "按名称、类型或 node-id 搜索本地 .fig/.fig.json 里的节点。",
      inputSchema: listNodesParams,
      annotations: { readOnlyHint: true }
    },
    async (params: ListNodesParams) =>
      jsonResponse(
        listFigNodes(params.filePath, {
          query: params.query,
          type: params.type,
          limit: params.limit,
          includeHidden: params.includeHidden
        })
      )
  )

  server.registerTool(
    "get_design_context",
    {
      title: "Get design context",
      description: "官方 Figma MCP 风格的设计上下文工具：返回节点树、样式、tokens 和代码提示。",
      inputSchema: designContextParams,
      annotations: { readOnlyHint: true }
    },
    async (params: DesignContextParams) =>
      jsonResponse(
        getDesignContext({
          filePath: params.filePath,
          nodeQuery: params.nodeQuery,
          depth: params.depth,
          includeTokens: params.includeTokens,
          includeCodeHints: params.includeCodeHints
        })
      )
  )

  server.registerTool(
    "get_code_context",
    {
      title: "Get code context",
      description: "返回适合代码生成的布局、样式、导出资源提示和子节点实现线索。",
      inputSchema: codeContextParams,
      annotations: { readOnlyHint: true }
    },
    async (params: CodeContextParams) =>
      jsonResponse(
        getCodeContext({
          filePath: params.filePath,
          nodeQuery: params.nodeQuery,
          depth: params.depth
        })
      )
  )

  server.registerTool(
    "get_make_context",
    {
      title: "Get Figma Make context",
      description: "读取 Figma Make .make 文件，返回包结构、源码文件、代码组件/实例、meta 和 AI 对话摘要。",
      inputSchema: makeContextParams,
      annotations: { readOnlyHint: true }
    },
    async (params: MakeContextParams) =>
      jsonResponse(
        getMakeContext(params.filePath, {
          includeSource: params.includeSource,
          sourceMaxLength: params.sourceMaxLength,
          fileQuery: params.fileQuery,
          includeAiChat: params.includeAiChat,
          maxMessages: params.maxMessages
        })
      )
  )

  server.registerTool(
    "export_assets",
    {
      title: "Export design assets",
      description: "批量导出本地 .fig/.fig.json 中的多个节点为 SVG 或本地 figma-like PNG。",
      inputSchema: exportAssetsParams,
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (params: ExportAssetsParams) =>
      jsonResponse(
        exportAssets({
          filePath: params.filePath,
          nodeQueries: params.nodeQueries,
          outputDir: params.outputDir,
          format: params.format,
          scale: params.scale,
          background: params.background,
          pngRenderer: params.pngRenderer
        })
      )
  )

  server.registerTool(
    "get_design_tokens",
    {
      title: "Get design tokens",
      description: "从本地 .fig/.fig.json 的全文件或指定节点子树中推导颜色、渐变、阴影和描边 token。",
      inputSchema: designTokensParams,
      annotations: { readOnlyHint: true }
    },
    async (params: DesignTokensParams) => jsonResponse(getDesignTokens(params.filePath, params.nodeQuery))
  )

  server.registerTool(
    "inspect_fig_file",
    {
      title: "Inspect local .fig file",
      description: "读取本地 .fig/.fig.json，返回节点数量、类型统计和节点摘要。",
      inputSchema: inspectParams,
      annotations: { readOnlyHint: true }
    },
    async (params: InspectParams) => jsonResponse(inspectFigFile(params.filePath, params.maxNodes))
  )

  server.registerTool(
    "get_fig_node",
    {
      title: "Get local Figma node",
      description: "按节点名或 node-id 从本地 .fig/.fig.json 中查找节点，并返回简化上下文。",
      inputSchema: getNodeParams,
      annotations: { readOnlyHint: true }
    },
    async (params: GetNodeParams) => jsonResponse(getFigNodeContext(params.filePath, params.nodeQuery, params.depth))
  )

  server.registerTool(
    "export_fig_node",
    {
      title: "Export local Figma node",
      description: "把本地 .fig/.fig.json 中的指定节点导出为 SVG 或本地 figma-like PNG。",
      inputSchema: exportNodeParams,
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (params: ExportNodeParams) =>
      jsonResponse(
        exportFigNode({
          filePath: params.filePath,
          nodeQuery: params.nodeQuery,
          outputPath: params.outputPath,
          format: params.format,
          scale: params.scale,
          background: params.background,
          pngRenderer: params.pngRenderer
        })
      )
  )

  return server
}

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  }
}
