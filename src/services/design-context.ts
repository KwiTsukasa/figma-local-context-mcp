import path from "node:path"
import type { FigColor, FigJson, FigNode, FigPaint } from "./fig-types.js"
import { exportFigNode, type ExportNodeResult } from "./export-node.js"
import { getChildrenByParent, findTargetNode } from "./fig-node-svg.js"
import { getRootNode, loadFigFile, serializeNode, summarizeNode } from "./fig-file.js"
import { keyForGuid, sanitizeFilePart } from "../utils/node-id.js"

export type NodeListOptions = {
  query?: string
  type?: string
  limit: number
  includeHidden: boolean
}

export type DesignContextOptions = {
  filePath: string
  nodeQuery?: string
  depth: number
  includeTokens: boolean
  includeCodeHints: boolean
}

export type CodeContextOptions = {
  filePath: string
  nodeQuery: string
  depth: number
}

export type ExportAssetsOptions = {
  filePath: string
  nodeQueries: string[]
  outputDir: string
  format: "svg" | "png"
  scale: number
  background?: string
}

export function listFigNodes(filePath: string, options: NodeListOptions) {
  const figJson = loadFigFile(filePath)
  const childrenByParent = getChildrenByParent(figJson)
  const normalizedQuery = options.query?.trim().toLowerCase()
  const normalizedType = options.type?.trim().toUpperCase()
  const nodes = (figJson.nodeChanges ?? [])
    .filter((node) => options.includeHidden || node.visible !== false)
    .filter((node) => !normalizedType || node.type?.toUpperCase() === normalizedType)
    .filter((node) => {
      if (!normalizedQuery) return true
      const haystack = `${node.name ?? ""} ${node.type ?? ""} ${keyForGuid(node.guid)}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
    .slice(0, options.limit)

  return {
    filePath: path.resolve(filePath),
    query: options.query,
    type: options.type,
    count: nodes.length,
    nodes: nodes.map((node) => summarizeNode(node, childrenByParent))
  }
}

export function getDesignContext(options: DesignContextOptions) {
  const figJson = loadFigFile(options.filePath)
  const childrenByParent = getChildrenByParent(figJson)
  const target = options.nodeQuery ? findTargetNode(figJson, { nodeQuery: options.nodeQuery }) : getRootNode(figJson)
  if (!target) {
    throw new Error("文件中没有可用节点")
  }

  return {
    kind: "figma-local-design-context",
    filePath: path.resolve(options.filePath),
    query: options.nodeQuery,
    node: serializeNode(target, childrenByParent, options.depth),
    tokens: options.includeTokens ? collectDesignTokens(figJson, target, childrenByParent) : undefined,
    codeHints: options.includeCodeHints ? buildCodeHints(target, childrenByParent, options.depth) : undefined
  }
}

export function getCodeContext(options: CodeContextOptions) {
  const figJson = loadFigFile(options.filePath)
  const childrenByParent = getChildrenByParent(figJson)
  const target = findTargetNode(figJson, { nodeQuery: options.nodeQuery })

  return {
    kind: "figma-local-code-context",
    filePath: path.resolve(options.filePath),
    query: options.nodeQuery,
    node: summarizeNode(target, childrenByParent),
    implementationHints: buildCodeHints(target, childrenByParent, options.depth)
  }
}

export function exportAssets(options: ExportAssetsOptions) {
  const results: ExportNodeResult[] = []
  for (const nodeQuery of options.nodeQueries) {
    const fileName = `${sanitizeFilePart(nodeQuery)}${options.format === "png" ? `@${options.scale}x` : ""}.${options.format}`
    results.push(
      exportFigNode({
        filePath: options.filePath,
        nodeQuery,
        outputPath: path.join(options.outputDir, fileName),
        format: options.format,
        scale: options.scale,
        background: options.background
      })
    )
  }

  return {
    filePath: path.resolve(options.filePath),
    outputDir: path.resolve(options.outputDir),
    count: results.length,
    assets: results
  }
}

export function getDesignTokens(filePath: string, nodeQuery?: string) {
  const figJson = loadFigFile(filePath)
  const childrenByParent = getChildrenByParent(figJson)
  const target = nodeQuery ? findTargetNode(figJson, { nodeQuery }) : getRootNode(figJson)
  if (!target) {
    throw new Error("文件中没有可用节点")
  }

  return {
    filePath: path.resolve(filePath),
    query: nodeQuery,
    tokens: collectDesignTokens(figJson, target, childrenByParent)
  }
}

function buildCodeHints(node: FigNode, childrenByParent: Map<string, FigNode[]>, depth: number): unknown {
  const children = childrenByParent.get(keyForGuid(node.guid)) ?? []
  const hints = {
    id: keyForGuid(node.guid),
    name: node.name,
    type: node.type,
    box: {
      width: node.size?.x,
      height: node.size?.y,
      x: node.transform?.m02,
      y: node.transform?.m12
    },
    css: {
      opacity: node.opacity,
      fills: simplifyPaintsForCode(node.fillPaints),
      strokes: simplifyPaintsForCode(node.strokePaints),
      strokeWidth: node.strokeWeight,
      shadows: node.effects
        ?.filter((effect) => effect.visible !== false && effect.type === "DROP_SHADOW")
        .map((effect) => ({
          x: effect.offset?.x ?? 0,
          y: effect.offset?.y ?? 0,
          blur: effect.radius ?? 0,
          spread: effect.spread ?? 0,
          color: colorToCss(effect.color)
        }))
    },
    exportHint:
      node.type === "VECTOR" || node.type === "ELLIPSE" || node.type === "FRAME"
        ? `Use export_fig_node or export_assets with nodeQuery "${keyForGuid(node.guid)}" for exact SVG/PNG.`
        : undefined
  }

  if (depth <= 0) return hints

  return {
    ...hints,
    children: children
      .sort((a, b) => (a.parentIndex?.position ?? "").localeCompare(b.parentIndex?.position ?? ""))
      .map((child) => buildCodeHints(child, childrenByParent, depth - 1))
  }
}

function collectDesignTokens(figJson: FigJson, root: FigNode, childrenByParent: Map<string, FigNode[]>) {
  const colors = new Map<string, { value: string; count: number; examples: string[] }>()
  const gradients = new Map<string, { value: string[]; count: number; examples: string[] }>()
  const shadows = new Map<string, { value: unknown; count: number; examples: string[] }>()
  const strokeWidths = new Map<string, { value: number; count: number; examples: string[] }>()

  // Tokens are inferred from the selected subtree instead of global styles,
  // because local .fig decoding does not yet resolve Figma's variable/style registry.
  for (const node of walkSubtree(root, childrenByParent)) {
    const example = `${node.name ?? "未命名"} (${keyForGuid(node.guid)})`
    for (const paint of [...(node.fillPaints ?? []), ...(node.strokePaints ?? [])]) {
      if (paint.visible === false) continue
      if (paint.type === "SOLID") {
        addToken(colors, colorToCss(paint.color), colorToCss(paint.color), example)
      } else if (paint.type === "GRADIENT_LINEAR") {
        const stops = paint.stops?.map((stop) => `${formatPercent(stop.position)} ${colorToCss(stop.color)}`) ?? []
        addToken(gradients, stops.join(" | "), stops, example)
      }
    }

    for (const effect of node.effects ?? []) {
      if (effect.visible === false || effect.type !== "DROP_SHADOW") continue
      const value = {
        x: effect.offset?.x ?? 0,
        y: effect.offset?.y ?? 0,
        blur: effect.radius ?? 0,
        spread: effect.spread ?? 0,
        color: colorToCss(effect.color)
      }
      addToken(shadows, JSON.stringify(value), value, example)
    }

    if (node.strokeWeight != null) {
      addToken(strokeWidths, String(node.strokeWeight), node.strokeWeight, example)
    }
  }

  return {
    nodeCount: figJson.nodeChanges?.length ?? 0,
    colors: [...colors.values()],
    gradients: [...gradients.values()],
    shadows: [...shadows.values()],
    strokeWidths: [...strokeWidths.values()]
  }
}

function* walkSubtree(root: FigNode, childrenByParent: Map<string, FigNode[]>): Generator<FigNode> {
  yield root
  for (const child of childrenByParent.get(keyForGuid(root.guid)) ?? []) {
    yield* walkSubtree(child, childrenByParent)
  }
}

function addToken<T>(
  map: Map<string, { value: T; count: number; examples: string[] }>,
  key: string,
  value: T,
  example: string
) {
  const current = map.get(key)
  if (current) {
    current.count += 1
    if (current.examples.length < 5) current.examples.push(example)
    return
  }

  map.set(key, { value, count: 1, examples: [example] })
}

function simplifyPaintsForCode(paints: FigPaint[] | undefined) {
  if (!paints?.length) return undefined

  return paints
    .filter((paint) => paint.visible !== false)
    .map((paint) => {
      if (paint.type === "SOLID") return colorToCss(paint.color)
      if (paint.type === "GRADIENT_LINEAR") {
        const stops = paint.stops?.map((stop) => `${colorToCss(stop.color)} ${formatPercent(stop.position)}`) ?? []
        return `linear-gradient(${stops.join(", ")})`
      }
      return paint.type
    })
}

function colorToCss(color?: FigColor): string {
  if (!color) return "rgb(0 0 0 / 1)"

  return `rgb(${toByte(color.r)} ${toByte(color.g)} ${toByte(color.b)} / ${trimNumber(color.a)})`
}

function toByte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
}

function formatPercent(value: number): string {
  return `${trimNumber(value * 100)}%`
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(4)).toString()
}
