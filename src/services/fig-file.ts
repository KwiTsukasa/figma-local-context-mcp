import fs from "node:fs"
import path from "node:path"
import type { FigJson, FigNode } from "./fig-types.js"
import { figToJson } from "./fig2json.js"
import { findTargetNode, getChildrenByParent } from "./fig-node-svg.js"
import { keyForGuid, normalizeNodeId } from "../utils/node-id.js"

export type NodeSummary = {
  id: string
  name?: string
  type?: string
  parentId?: string
  visible?: boolean
  opacity?: number
  size?: { x: number; y: number }
  childCount: number
  hasFill: boolean
  hasStroke: boolean
  hasEffects: boolean
}

export type FileSummary = {
  filePath: string
  nodeCount: number
  blobCount: number
  topTypes: Record<string, number>
  nodes: NodeSummary[]
}

export function loadFigFile(filePath: string): FigJson {
  const absolutePath = path.resolve(filePath)
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`文件不存在：${absolutePath}`)
  }

  if (absolutePath.toLowerCase().endsWith(".json")) {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as FigJson
  }

  return figToJson(fs.readFileSync(absolutePath))
}

export function inspectFigFile(filePath: string, maxNodes: number): FileSummary {
  const figJson = loadFigFile(filePath)
  const childrenByParent = getChildrenByParent(figJson)
  const nodes = figJson.nodeChanges ?? []
  const topTypes: Record<string, number> = {}

  for (const node of nodes) {
    const type = node.type ?? "UNKNOWN"
    topTypes[type] = (topTypes[type] ?? 0) + 1
  }

  return {
    filePath: path.resolve(filePath),
    nodeCount: nodes.length,
    blobCount: figJson.blobs?.length ?? 0,
    topTypes: Object.fromEntries(Object.entries(topTypes).sort((a, b) => b[1] - a[1])),
    nodes: nodes.slice(0, maxNodes).map((node) => summarizeNode(node, childrenByParent))
  }
}

export function getFigNodeContext(filePath: string, nodeQuery: string, depth: number): unknown {
  const figJson = loadFigFile(filePath)
  const target = findTargetNode(figJson, { nodeQuery })
  const childrenByParent = getChildrenByParent(figJson)

  return {
    filePath: path.resolve(filePath),
    query: nodeQuery,
    normalizedNodeId: normalizeNodeId(nodeQuery),
    node: serializeNode(target, childrenByParent, depth)
  }
}

export function getRootNode(figJson: FigJson): FigNode | undefined {
  const nodes = figJson.nodeChanges ?? []
  return (
    nodes.find((node) => node.type === "DOCUMENT") ??
    nodes.find((node) => !node.parentIndex?.guid) ??
    nodes[0]
  )
}

export function summarizeNode(node: FigNode, childrenByParent: Map<string, FigNode[]>): NodeSummary {
  return {
    id: keyForGuid(node.guid),
    name: node.name,
    type: node.type,
    parentId: keyForGuid(node.parentIndex?.guid) || undefined,
    visible: node.visible,
    opacity: node.opacity,
    size: node.size,
    childCount: childrenByParent.get(keyForGuid(node.guid))?.length ?? 0,
    hasFill: Boolean(node.fillPaints?.length),
    hasStroke: Boolean(node.strokePaints?.length),
    hasEffects: Boolean(node.effects?.length)
  }
}

export function serializeNode(node: FigNode, childrenByParent: Map<string, FigNode[]>, depth: number): unknown {
  const children = childrenByParent.get(keyForGuid(node.guid)) ?? []
  const summary = {
    ...summarizeNode(node, childrenByParent),
    transform: node.transform,
    strokeWeight: node.strokeWeight,
    strokeAlign: node.strokeAlign,
    arcData: node.arcData,
    fills: simplifyPaints(node.fillPaints),
    strokes: simplifyPaints(node.strokePaints),
    effects: node.effects,
    geometry: {
      fillCount: node.fillGeometry?.length ?? 0,
      strokeCount: node.strokeGeometry?.length ?? 0
    }
  }

  if (depth <= 0) return summary

  return {
    ...summary,
    children: children
      .sort((a, b) => (a.parentIndex?.position ?? "").localeCompare(b.parentIndex?.position ?? ""))
      .map((child) => serializeNode(child, childrenByParent, depth - 1))
  }
}

function simplifyPaints(paints: FigNode["fillPaints"]): unknown[] | undefined {
  if (!paints?.length) return undefined

  return paints.map((paint) => ({
    type: paint.type,
    visible: paint.visible,
    opacity: paint.opacity,
    color: paint.color,
    stops: paint.stops
  }))
}
