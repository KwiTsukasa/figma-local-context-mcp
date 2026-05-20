import type {
  Bounds,
  FigArcData,
  FigColor,
  FigEffect,
  FigGeometry,
  FigJson,
  FigNode,
  FigPaint,
  FigmaMatrix
} from "./fig-types.js"
import { keyForGuid, normalizeNodeId } from "../utils/node-id.js"

type SvgMatrix = [number, number, number, number, number, number]

type ParsedPath = {
  d: string
  bounds: Bounds
}

type RenderContext = {
  figJson: FigJson
  childrenByParent: Map<string, FigNode[]>
  defs: string[]
  bounds: Bounds | null
  idSeed: number
}

export type RenderOptions = {
  nodeName?: string
  nodeId?: string
  nodeQuery?: string
  scale?: number
  background?: string
}

export type RenderedSvg = {
  svg: string
  width: number
  height: number
  viewBox: Bounds
  node: FigNode
}

const IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0]
const COMMAND_MOVE = 1
const COMMAND_LINE = 2
const COMMAND_CUBIC = 4
const COMMAND_CLOSE = 0

export function renderNodeToSvg(figJson: FigJson, options: RenderOptions): RenderedSvg {
  const target = findTargetNode(figJson, options)
  const childrenByParent = getChildrenByParent(figJson)
  const context: RenderContext = {
    figJson,
    childrenByParent,
    defs: [],
    bounds: null,
    idSeed: 0
  }

  const body = renderNodeSubtree(context, target, IDENTITY, true)
  const bounds = context.bounds ?? { minX: 0, minY: 0, maxX: target.size?.x ?? 0, maxY: target.size?.y ?? 0 }
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const scale = options.scale ?? 2
  const background = options.background
    ? `<rect x="${format(bounds.minX)}" y="${format(bounds.minY)}" width="${format(width)}" height="${format(height)}" fill="${escapeAttribute(options.background)}"/>`
    : ""
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${format(width * scale)}" height="${format(
      height * scale
    )}" viewBox="${format(bounds.minX)} ${format(bounds.minY)} ${format(width)} ${format(height)}" shape-rendering="geometricPrecision">`,
    context.defs.length ? `<defs>${context.defs.join("")}</defs>` : "",
    background,
    body,
    "</svg>"
  ].join("")

  return { svg, width: width * scale, height: height * scale, viewBox: bounds, node: target }
}

export function findTargetNode(figJson: FigJson, options: RenderOptions): FigNode {
  const nodes = figJson.nodeChanges ?? []
  const rawQuery = options.nodeId ?? options.nodeQuery
  const normalizedNodeId = normalizeNodeId(rawQuery)
  const nodeName = options.nodeName ?? (normalizedNodeId ? undefined : options.nodeQuery)
  const target = normalizedNodeId
    ? nodes.find((node) => keyForGuid(node.guid) === normalizedNodeId)
    : nodes.find((node) => node.name === nodeName)

  if (!target) {
    throw new Error(`找不到节点：${options.nodeId ?? options.nodeName ?? options.nodeQuery}`)
  }

  return target
}

export function getChildrenByParent(figJson: FigJson): Map<string, FigNode[]> {
  const childrenByParent = new Map<string, FigNode[]>()
  for (const node of figJson.nodeChanges ?? []) {
    if (!node.parentIndex?.guid) continue

    const parentKey = keyForGuid(node.parentIndex.guid)
    const children = childrenByParent.get(parentKey) ?? []
    children.push(node)
    childrenByParent.set(parentKey, children)
  }

  return childrenByParent
}

function renderNodeSubtree(
  context: RenderContext,
  node: FigNode,
  parentMatrix: SvgMatrix,
  isRoot = false
): string {
  if (node.visible === false) return ""

  const localMatrix = isRoot ? IDENTITY : toSvgMatrix(node.transform)
  const matrix = multiply(parentMatrix, localMatrix)
  const nodeContent = [
    ...renderGeometry(context, node, node.fillGeometry, node.fillPaints, matrix),
    ...renderStrokeGeometry(context, node, matrix),
    ...getSortedChildren(context, node).map((child) => renderNodeSubtree(context, child, matrix))
  ].join("")

  if (!nodeContent) return ""

  const transform = matrixToAttribute(localMatrix)
  const opacity = node.opacity != null && node.opacity !== 1 ? ` opacity="${format(node.opacity)}"` : ""
  const filterId = createNodeEffectFilter(context, node, matrix)
  const filter = filterId ? ` filter="url(#${filterId})"` : ""

  return `<g${transform}${opacity}${filter}>${nodeContent}</g>`
}

function renderStrokeGeometry(context: RenderContext, node: FigNode, matrix: SvgMatrix): string[] {
  const outsideEllipseStroke = renderOutsideEllipseStroke(context, node, matrix)
  if (outsideEllipseStroke) return outsideEllipseStroke

  return renderGeometry(context, node, node.strokeGeometry, node.strokePaints, matrix)
}

function renderOutsideEllipseStroke(context: RenderContext, node: FigNode, matrix: SvgMatrix): string[] | null {
  const strokeWeight = node.strokeWeight ?? 0
  if (
    node.type !== "ELLIPSE" ||
    node.strokeAlign !== "OUTSIDE" ||
    !node.size ||
    !node.strokePaints?.length ||
    strokeWeight <= 0 ||
    !isFullEllipse(node.arcData)
  ) {
    return null
  }

  const bounds = {
    minX: -strokeWeight,
    minY: -strokeWeight,
    maxX: node.size.x + strokeWeight,
    maxY: node.size.y + strokeWeight
  }
  includeBounds(context, transformBounds(matrix, bounds))

  return node.strokePaints
    .filter((paint) => paint.visible !== false)
    .map((paint) => {
      const stroke = paintToSvgFill(context, node, bounds, paint)
      const opacity = paint.opacity != null && paint.opacity !== 1 ? ` stroke-opacity="${format(paint.opacity)}"` : ""
      const rx = node.size!.x / 2 + strokeWeight / 2
      const ry = node.size!.y / 2 + strokeWeight / 2

      // Figma's strokeGeometry for OUTSIDE ellipses is an expanded filled
      // outline. Using it directly paints inward and erases the ring gap, so
      // complete ellipses are emitted as actual outside strokes.
      return `<ellipse cx="${format(node.size!.x / 2)}" cy="${format(node.size!.y / 2)}" rx="${format(
        rx
      )}" ry="${format(ry)}" fill="none" stroke="${stroke}" stroke-width="${format(strokeWeight)}"${opacity}/>`
    })
}

function isFullEllipse(arcData?: FigArcData): boolean {
  if (!arcData) return true

  const start = arcData.startingAngle ?? 0
  const end = arcData.endingAngle ?? Math.PI * 2
  const delta = Math.abs(end - start)
  return (arcData.innerRadius ?? 0) === 0 && Math.abs(delta - Math.PI * 2) < 0.001
}

function renderGeometry(
  context: RenderContext,
  node: FigNode,
  geometries: FigGeometry[] | undefined,
  paints: FigPaint[] | undefined,
  matrix: SvgMatrix
): string[] {
  if (!geometries?.length || !paints?.length) return []

  return geometries.flatMap((geometry) => {
    const parsed = parsePathBlob(context.figJson, geometry.commandsBlob)
    const transformedBounds = transformBounds(matrix, parsed.bounds)
    includeBounds(context, transformedBounds)

    return paints
      .filter((paint) => paint.visible !== false)
      .map((paint) => {
        const fill = paintToSvgFill(context, node, parsed.bounds, paint)
        const opacity = paint.opacity != null && paint.opacity !== 1 ? ` fill-opacity="${format(paint.opacity)}"` : ""

        return `<path d="${parsed.d}" fill="${fill}"${opacity}/>`
      })
  })
}

function parsePathBlob(figJson: FigJson, blobIndex: number): ParsedPath {
  const blob = figJson.blobs?.[blobIndex]
  if (!blob) {
    throw new Error(`缺少几何数据 blob：${blobIndex}`)
  }

  const bytes = base64ToBytes(blob)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let d = ""
  const bounds = createEmptyBounds()

  const readFloat = () => {
    const value = view.getFloat32(offset, true)
    offset += 4
    return value
  }
  const readPoint = () => {
    const x = readFloat()
    const y = readFloat()
    includePoint(bounds, x, y)
    return `${format(x)} ${format(y)}`
  }

  // Figma stores flattened vector commands as compact opcodes followed by
  // little-endian float coordinates: 1=M, 2=L, 4=C, 0=Z.
  while (offset < bytes.length) {
    const command = bytes[offset]
    offset += 1

    if (command === COMMAND_MOVE) {
      d += `M ${readPoint()} `
    } else if (command === COMMAND_LINE) {
      d += `L ${readPoint()} `
    } else if (command === COMMAND_CUBIC) {
      d += `C ${readPoint()} ${readPoint()} ${readPoint()} `
    } else if (command === COMMAND_CLOSE) {
      d += "Z "
    } else {
      throw new Error(`几何数据 blob ${blobIndex} 中存在不支持的向量命令：${command}`)
    }
  }

  return { d: d.trim(), bounds }
}

function paintToSvgFill(context: RenderContext, node: FigNode, pathBounds: Bounds, paint: FigPaint): string {
  if (paint.type === "SOLID") {
    return colorToCss(paint.color)
  }

  if (paint.type === "GRADIENT_LINEAR") {
    const id = nextId(context, "gradient")
    const gradient = getLinearGradientLine(node, pathBounds, paint)
    const stops = paint.stops
      ?.map(
        (stop) =>
          `<stop offset="${format(stop.position * 100)}%" stop-color="${colorToCss(stop.color)}" stop-opacity="${format(
            stop.color.a
          )}"/>`
      )
      .join("")

    context.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${format(gradient.x1)}" y1="${format(
        gradient.y1
      )}" x2="${format(gradient.x2)}" y2="${format(gradient.y2)}">${stops ?? ""}</linearGradient>`
    )
    return `url(#${id})`
  }

  throw new Error(`不支持的填充类型：${paint.type}`)
}

function getLinearGradientLine(node: FigNode, pathBounds: Bounds, paint: FigPaint) {
  const width = node.size?.x || pathBounds.maxX - pathBounds.minX
  const height = node.size?.y || pathBounds.maxY - pathBounds.minY
  const originX = pathBounds.minX < 0 ? pathBounds.minX : 0
  const originY = pathBounds.minY < 0 ? pathBounds.minY : 0
  const inverse = invert(toSvgMatrix(paint.transform))

  // Figma's stored gradient transform maps local object space back into the
  // unit gradient space, so SVG needs the inverse projected onto the node box.
  const start = applyToPoint(inverse, 0, 0)
  const end = applyToPoint(inverse, 1, 0)

  return {
    x1: originX + start.x * width,
    y1: originY + start.y * height,
    x2: originX + end.x * width,
    y2: originY + end.y * height
  }
}

function createFilter(context: RenderContext, effects: FigEffect[] | undefined, bounds: Bounds): string | null {
  const shadow = effects?.find((effect) => effect.visible !== false && effect.type === "DROP_SHADOW")
  if (!shadow) return null

  const id = nextId(context, "shadow")
  const radius = shadow.radius ?? 0
  const spread = shadow.spread ?? 0
  const offsetX = shadow.offset?.x ?? 0
  const offsetY = shadow.offset?.y ?? 0
  const x = bounds.minX + Math.min(0, offsetX) - radius - spread
  const y = bounds.minY + Math.min(0, offsetY) - radius - spread
  const width = bounds.maxX - bounds.minX + Math.abs(offsetX) + radius * 2 + spread * 2
  const height = bounds.maxY - bounds.minY + Math.abs(offsetY) + radius * 2 + spread * 2
  const sourceAlpha = spread
    ? `<feMorphology in="SourceAlpha" operator="${spread > 0 ? "dilate" : "erode"}" radius="${format(
        Math.abs(spread)
      )}" result="spreadAlpha"/>`
    : ""
  const blurInput = spread ? "spreadAlpha" : "SourceAlpha"
  const shadowResult = shadow.showShadowBehindNode === false ? "visibleShadow" : "shadow"
  const hideShadowBehindSource =
    shadow.showShadowBehindNode === false
      ? `<feComposite in="shadow" in2="SourceAlpha" operator="out" result="visibleShadow"/>`
      : ""

  // Figma can store showShadowBehindNode=false. SVG's feDropShadow always
  // leaves the blurred shadow under the source, so we build the filter steps
  // manually and subtract SourceAlpha when Figma says the shadow is outside-only.
  context.defs.push(
    `<filter id="${id}" x="${format(x)}" y="${format(y)}" width="${format(width)}" height="${format(
      height
    )}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${sourceAlpha}<feGaussianBlur in="${blurInput}" stdDeviation="${format(
      radius / 2
    )}" result="blurredShadow"/><feOffset in="blurredShadow" dx="${format(offsetX)}" dy="${format(
      offsetY
    )}" result="offsetShadow"/><feFlood flood-color="${colorToCss(shadow.color)}" flood-opacity="${format(
      shadow.color?.a ?? 1
    )}" result="shadowColor"/><feComposite in="shadowColor" in2="offsetShadow" operator="in" result="shadow"/>${hideShadowBehindSource}<feMerge><feMergeNode in="${shadowResult}"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
  )

  return id
}

function createNodeEffectFilter(context: RenderContext, node: FigNode, matrix: SvgMatrix): string | null {
  const localBounds = getNodeLocalBounds(context, node)
  if (!localBounds) return null

  // Effects belong to the Figma layer itself. Frames/groups can carry shadows
  // even when their own fill paints are empty, so the filter must wrap the
  // rendered layer content instead of only individual geometry paths.
  const filterId = createFilter(context, node.effects, localBounds)
  if (!filterId) return null

  includeBounds(context, transformBounds(matrix, expandBoundsForEffects(localBounds, node.effects)))
  return filterId
}

function getNodeLocalBounds(context: RenderContext, node: FigNode): Bounds | null {
  const geometryBounds = getGeometryLocalBounds(context, node)
  if (geometryBounds) return geometryBounds

  if (!node.size) return null

  return {
    minX: 0,
    minY: 0,
    maxX: node.size.x,
    maxY: node.size.y
  }
}

function getGeometryLocalBounds(context: RenderContext, node: FigNode): Bounds | null {
  const geometries = [...(node.fillGeometry ?? []), ...(node.strokeGeometry ?? [])]
  let bounds: Bounds | null = null

  for (const geometry of geometries) {
    const parsed = parsePathBlob(context.figJson, geometry.commandsBlob)
    bounds = bounds ? unionBounds(bounds, parsed.bounds) : { ...parsed.bounds }
  }

  return bounds && Number.isFinite(bounds.minX) ? bounds : null
}

function getSortedChildren(context: RenderContext, node: FigNode): FigNode[] {
  return [...(context.childrenByParent.get(keyForGuid(node.guid)) ?? [])].sort((a, b) =>
    (a.parentIndex?.position ?? "").localeCompare(b.parentIndex?.position ?? "")
  )
}

function nextId(context: RenderContext, prefix: string): string {
  context.idSeed += 1
  return `${prefix}-${context.idSeed}`
}

function toSvgMatrix(matrix?: FigmaMatrix): SvgMatrix {
  if (!matrix) return IDENTITY
  return [matrix.m00, matrix.m10, matrix.m01, matrix.m11, matrix.m02, matrix.m12]
}

function matrixToAttribute(matrix: SvgMatrix): string {
  if (matrix.every((value, index) => value === IDENTITY[index])) return ""
  return ` transform="matrix(${matrix.map(format).join(" ")})"`
}

function multiply(left: SvgMatrix, right: SvgMatrix): SvgMatrix {
  const [a1, b1, c1, d1, e1, f1] = left
  const [a2, b2, c2, d2, e2, f2] = right

  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ]
}

function invert(matrix: SvgMatrix): SvgMatrix {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (Math.abs(determinant) < Number.EPSILON) return IDENTITY

  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant
  ]
}

function applyToPoint(matrix: SvgMatrix, x: number, y: number) {
  const [a, b, c, d, e, f] = matrix

  return {
    x: a * x + c * y + e,
    y: b * x + d * y + f
  }
}

function transformBounds(matrix: SvgMatrix, bounds: Bounds): Bounds {
  const points = [
    applyToPoint(matrix, bounds.minX, bounds.minY),
    applyToPoint(matrix, bounds.maxX, bounds.minY),
    applyToPoint(matrix, bounds.maxX, bounds.maxY),
    applyToPoint(matrix, bounds.minX, bounds.maxY)
  ]

  return points.reduce((next, point) => includePoint(next, point.x, point.y), createEmptyBounds())
}

function expandBoundsForEffects(bounds: Bounds, effects: FigEffect[] | undefined): Bounds {
  const next = { ...bounds }
  for (const effect of effects ?? []) {
    if (effect.visible === false || effect.type !== "DROP_SHADOW") continue

    const radius = effect.radius ?? 0
    const spread = effect.spread ?? 0
    const offsetX = effect.offset?.x ?? 0
    const offsetY = effect.offset?.y ?? 0
    next.minX = Math.min(next.minX, bounds.minX + offsetX - radius - spread)
    next.maxX = Math.max(next.maxX, bounds.maxX + offsetX + radius + spread)
    next.minY = Math.min(next.minY, bounds.minY + offsetY - radius - spread)
    next.maxY = Math.max(next.maxY, bounds.maxY + offsetY + radius + spread)
  }

  return next
}

function createEmptyBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  }
}

function includeBounds(context: RenderContext, bounds: Bounds) {
  context.bounds = context.bounds
    ? {
        minX: Math.min(context.bounds.minX, bounds.minX),
        minY: Math.min(context.bounds.minY, bounds.minY),
        maxX: Math.max(context.bounds.maxX, bounds.maxX),
        maxY: Math.max(context.bounds.maxY, bounds.maxY)
      }
    : { ...bounds }
}

function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY)
  }
}

function includePoint(bounds: Bounds, x: number, y: number): Bounds {
  bounds.minX = Math.min(bounds.minX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.maxX = Math.max(bounds.maxX, x)
  bounds.maxY = Math.max(bounds.maxY, y)
  return bounds
}

function colorToCss(color?: FigColor): string {
  if (!color) return "#000000"

  return `rgb(${toByte(color.r)} ${toByte(color.g)} ${toByte(color.b)})`
}

function toByte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
}

function base64ToBytes(value: string): Uint8Array {
  const buffer = Buffer.from(value, "base64")
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;")
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(4)).toString()
}
