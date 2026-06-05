import type {
  Bounds,
  FigArcData,
  FigColor,
  FigEffect,
  FigGeometry,
  FigJson,
  FigNode,
  FigPaint,
  FigTextGlyph,
  FigmaMatrix
} from "./fig-types.js"
import type { FigImageAssets } from "./fig-images.js"
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
  rasterHints: FigmaLikeRasterHint[]
  imageAssets: FigImageAssets
  bounds: Bounds | null
  effectBounds: Bounds | null
  idSeed: number
  pngFigmaLike: boolean
}

export type FigmaLikeRasterHint = {
  type: "ellipse-inner-shadow"
  matrix: SvgMatrix
  cx: number
  cy: number
  rx: number
  ry: number
  color: FigColor
  opacity: number
  spread: number
  blurSigma: number
}

export type RenderOptions = {
  nodeName?: string
  nodeId?: string
  nodeQuery?: string
  scale?: number
  background?: string
  pngFigmaLike?: boolean
  imageAssets?: FigImageAssets
}

export type RenderedSvg = {
  svg: string
  width: number
  height: number
  viewBox: Bounds
  rasterHints: FigmaLikeRasterHint[]
  node: FigNode
}

const IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0]
const COMMAND_MOVE = 1
const COMMAND_LINE = 2
const COMMAND_QUADRATIC = 3
const COMMAND_CUBIC = 4
const COMMAND_CLOSE = 0

export function renderNodeToSvg(figJson: FigJson, options: RenderOptions): RenderedSvg {
  const target = findTargetNode(figJson, options)
  const childrenByParent = getChildrenByParent(figJson)
  const context: RenderContext = {
    figJson,
    childrenByParent,
    defs: [],
    rasterHints: [],
    imageAssets: options.imageAssets ?? new Map(),
    bounds: null,
    effectBounds: null,
    idSeed: 0,
    pngFigmaLike: options.pngFigmaLike ?? false
  }

  const body = renderNodeSubtree(context, target, IDENTITY, true)
  const bounds = getRootExportBounds(target, context.bounds, context.effectBounds)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const scale = options.scale ?? 2
  const pixelWidth = getFigmaPixelSize(width, scale)
  const pixelHeight = getFigmaPixelSize(height, scale)
  // Figma exports selected nodes at ceil(size * scale) without stretching the
  // artwork; extra fractional pixels become transparent canvas at the edge.
  const viewBox = {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.minX + pixelWidth / scale,
    maxY: bounds.minY + pixelHeight / scale
  }
  const viewBoxWidth = viewBox.maxX - viewBox.minX
  const viewBoxHeight = viewBox.maxY - viewBox.minY
  const background = options.background
    ? `<rect x="${format(viewBox.minX)}" y="${format(viewBox.minY)}" width="${format(
        viewBoxWidth
      )}" height="${format(viewBoxHeight)}" fill="${escapeAttribute(options.background)}"/>`
    : ""
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${format(pixelWidth)}" height="${format(
      pixelHeight
    )}" viewBox="${format(viewBox.minX)} ${format(viewBox.minY)} ${format(viewBoxWidth)} ${format(
      viewBoxHeight
    )}" shape-rendering="geometricPrecision">`,
    context.defs.length ? `<defs>${context.defs.join("")}</defs>` : "",
    background,
    body,
    "</svg>"
  ].join("")

  return { svg, width: pixelWidth, height: pixelHeight, viewBox, rasterHints: context.rasterHints, node: target }
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
  // Boolean-operation children are construction geometry. Figma renders the
  // computed boolean path, not the source shapes again.
  const shouldRenderChildren =
    node.type !== "BOOLEAN_OPERATION" || !(node.fillGeometry?.length || node.strokeGeometry?.length)
  const nodeContent = [
    ...renderGeometry(context, node, node.fillGeometry, node.fillPaints, matrix),
    renderCodeSnapshot(context, node, matrix),
    renderTextNode(context, node, matrix),
    collectFigmaLikeEllipseInnerShadowHint(context, node, matrix),
    ...renderStrokeGeometry(context, node, matrix),
    ...(shouldRenderChildren ? renderChildNodes(context, node, matrix) : [])
  ].join("")

  if (!nodeContent) return ""

  const opacity = node.opacity != null && node.opacity !== 1 ? ` opacity="${format(node.opacity)}"` : ""
  const filterId = createNodeEffectFilter(context, node, matrix)
  const filter = filterId ? ` filter="url(#${filterId})"` : ""

  return `<g${opacity}${filter}>${nodeContent}</g>`
}

function renderChildNodes(context: RenderContext, node: FigNode, matrix: SvgMatrix): string[] {
  const output: string[] = []
  let activeClipId: string | null = null

  for (const child of getSortedChildren(context, node)) {
    if (child.visible === false) continue

    if (child.mask) {
      activeClipId = createMaskClipPath(context, child, matrix)
      continue
    }

    const rendered = renderNodeSubtree(context, child, matrix)
    if (!rendered) continue

    output.push(activeClipId ? `<g clip-path="url(#${activeClipId})">${rendered}</g>` : rendered)
  }

  return output
}

function createMaskClipPath(context: RenderContext, node: FigNode, parentMatrix: SvgMatrix): string | null {
  const content = renderClipPathNode(context, node, parentMatrix)
  if (!content) return null

  const id = nextId(context, "clip")
  context.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${content}</clipPath>`)
  return id
}

function renderClipPathNode(context: RenderContext, node: FigNode, parentMatrix: SvgMatrix): string {
  if (node.visible === false) return ""

  const matrix = multiply(parentMatrix, toSvgMatrix(node.transform))
  return [
    ...renderGeometryClipPaths(context, node.fillGeometry, matrix),
    ...renderGeometryClipPaths(context, node.strokeGeometry, matrix),
    ...renderTextClipPaths(context, node, matrix),
    ...getSortedChildren(context, node).map((child) => renderClipPathNode(context, child, matrix))
  ].join("")
}

function renderGeometryClipPaths(
  context: RenderContext,
  geometries: FigGeometry[] | undefined,
  matrix: SvgMatrix
): string[] {
  if (!geometries?.length) return []

  return geometries.flatMap((geometry) => {
    const parsed = tryParsePathBlob(context.figJson, geometry.commandsBlob)
    if (!parsed || !isFiniteBounds(parsed.bounds) || !parsed.d) return []

    const clipRule = geometry.windingRule === "ODD" ? ` clip-rule="evenodd"` : ""
    return `<path d="${transformPathData(parsed.d, matrix)}"${clipRule}/>`
  })
}

function renderTextClipPaths(context: RenderContext, node: FigNode, matrix: SvgMatrix): string[] {
  if (node.type !== "TEXT") return []

  return (
    node.derivedTextData?.glyphs?.flatMap((glyph) => {
      const parsed = parsePathBlob(context.figJson, glyph.commandsBlob)
      if (!isFiniteBounds(parsed.bounds) || !parsed.d) return []

      return `<path d="${transformPathData(parsed.d, getGlyphMatrix(glyph, matrix))}"/>`
    }) ?? []
  )
}

function renderTextNode(context: RenderContext, node: FigNode, matrix: SvgMatrix): string {
  if (node.type !== "TEXT") return ""

  const glyphs = node.derivedTextData?.glyphs
  const textBounds = getTextLocalBounds(node)
  if (!glyphs?.length || !textBounds) return ""

  const groups = new Map<string, { paints: FigPaint[]; paths: string[] }>()
  includeBounds(context, transformBounds(matrix, textBounds))

  for (const glyph of glyphs) {
    const parsed = parsePathBlob(context.figJson, glyph.commandsBlob)
    if (!isFiniteBounds(parsed.bounds) || !parsed.d) continue

    const paints = getTextGlyphPaints(node, glyph)
    if (!paints.length) continue

    const key = JSON.stringify(paints)
    const group = groups.get(key) ?? { paints, paths: [] }
    group.paths.push(transformPathData(parsed.d, getGlyphMatrix(glyph, matrix)))
    groups.set(key, group)
  }

  return [...groups.values()]
    .flatMap((group) => renderTextPaintGroup(context, node, textBounds, group.paints, matrix, group.paths))
    .join("")
}

function renderTextPaintGroup(
  context: RenderContext,
  node: FigNode,
  textBounds: Bounds,
  paints: FigPaint[],
  matrix: SvgMatrix,
  paths: string[]
): string[] {
  if (!paths.length) return []

  const d = paths.join(" ")
  return paints
    .filter((paint) => paint.visible !== false)
    .map((paint) => {
      if (paint.type === "IMAGE") return ""

      const fill = paintToSvgFill(context, node, textBounds, paint, matrix)
      const opacity = paintOpacityAttribute("fill", paint)
      return `<path d="${d}" fill="${fill}"${opacity}/>`
    })
}

function getTextGlyphPaints(node: FigNode, glyph: FigTextGlyph): FigPaint[] {
  const characterIndex = glyph.firstCharacter ?? 0
  const styleId = node.textData?.characterStyleIDs?.[characterIndex]
  const override = node.textData?.styleOverrideTable?.find((style) => style.styleID === styleId)

  return override?.fillPaints ?? node.fillPaints ?? []
}

function getTextLocalBounds(node: FigNode): Bounds | null {
  const size = node.derivedTextData?.layoutSize ?? node.size
  if (!size || size.x <= 0 || size.y <= 0) return null

  return {
    minX: 0,
    minY: 0,
    maxX: size.x,
    maxY: size.y
  }
}

function getGlyphMatrix(glyph: FigTextGlyph, textMatrix: SvgMatrix): SvgMatrix {
  const position = glyph.position ?? { x: 0, y: 0 }
  const fontSize = glyph.fontSize ?? 1
  const rotation = glyph.rotation ?? 0

  // Glyph blobs are normalized font outlines with positive Y going upward from
  // the baseline. SVG local space is Y-down, so text rendering needs a vertical
  // flip around Figma's stored glyph baseline.
  const scale: SvgMatrix = [fontSize, 0, 0, -fontSize, 0, 0]
  const glyphLocal =
    rotation === 0
      ? ([fontSize, 0, 0, -fontSize, position.x, position.y] as SvgMatrix)
      : multiply([Math.cos(rotation), Math.sin(rotation), -Math.sin(rotation), Math.cos(rotation), position.x, position.y], scale)

  return multiply(textMatrix, glyphLocal)
}

function renderStrokeGeometry(context: RenderContext, node: FigNode, matrix: SvgMatrix): string[] {
  const outsideEllipseStroke = renderOutsideEllipseStroke(context, node, matrix)
  if (outsideEllipseStroke) return outsideEllipseStroke

  const pathStroke = renderPathStroke(context, node, matrix)
  if (pathStroke?.length) return pathStroke

  return renderGeometry(context, node, node.strokeGeometry, node.strokePaints, matrix)
}

function renderPathStroke(context: RenderContext, node: FigNode, matrix: SvgMatrix): string[] | null {
  const strokeWeight = node.strokeWeight ?? 0
  if (!node.fillGeometry?.length || !node.strokePaints?.length || strokeWeight <= 0) return null
  const visibleStrokePaints = node.strokePaints.filter((paint) => paint.visible !== false)
  const hasGradientStroke = visibleStrokePaints.some((paint) => paint.type === "GRADIENT_LINEAR")
  if (visibleStrokePaints.some((paint) => paint.type !== "SOLID" && paint.type !== "GRADIENT_LINEAR")) return null
  if (hasGradientStroke && !shouldRenderGradientStrokeAsPath(node)) return null

  return node.fillGeometry.flatMap((geometry) => {
    const parsed = tryParsePathBlob(context.figJson, geometry.commandsBlob)
    if (!parsed || !isFiniteBounds(parsed.bounds) || !parsed.d) return []

    const expandedBounds = expandBounds(parsed.bounds, strokeWeight / 2)
    includeBounds(context, transformBounds(matrix, expandedBounds))
    const strokeMatrix = multiply(matrix, getStrokeAlignmentMatrix(parsed.bounds, strokeWeight, node.strokeAlign))
    const insetMiterPath = createInsetMiterStrokePath(parsed.d, strokeWeight, node.strokeAlign, matrix)

    // Figma's SVG export keeps normal vector strokes as stroke attributes. The
    // decoded strokeGeometry is an expanded outline for internal raster use; if
    // we fill it directly, thin isometric edges become much too thick.
    return visibleStrokePaints
      .map((paint) => {
        const stroke = paintToSvgFill(context, node, parsed.bounds, paint, matrix)
        const opacity = paintOpacityAttribute("stroke", paint)
        const dashArray = strokeDashArrayAttribute(node)
        return `<path d="${insetMiterPath ?? transformPathData(parsed.d, strokeMatrix)}" fill="none" stroke="${stroke}" stroke-width="${format(
          strokeWeight
        )}"${opacity}${dashArray}/>`
      })
  })
}

function tryParsePathBlob(figJson: FigJson, blobIndex: number): ParsedPath | null {
  const blob = figJson.blobs?.[blobIndex]
  if (!blob) return null

  return parsePathBlob(figJson, blobIndex)
}

function shouldRenderGradientStrokeAsPath(node: FigNode): boolean {
  return Boolean(node.type === "ELLIPSE" && node.size && isFullEllipse(node.arcData))
}

function createInsetMiterStrokePath(
  d: string,
  strokeWeight: number,
  strokeAlign: FigNode["strokeAlign"] | undefined,
  matrix: SvgMatrix
): string | null {
  if (strokeAlign !== "INSIDE") return null

  const segments = getStraightSegments(d)
  if (segments.length !== 4) return null

  const area = getSignedArea(segments.map((segment) => segment.from))
  const offsetLines = segments.map((segment) => offsetLine(segment.from, segment.to, strokeWeight / 2, area >= 0))
  const intersections = offsetLines.map((line, index) => intersectLines(offsetLines[(index + 3) % 4], line))
  if (intersections.some((point) => !point)) return null

  const points = [intersections[1]!, intersections[2]!, intersections[3]!, intersections[0]!].map((point) =>
    applyToPoint(matrix, point.x, point.y)
  )

  // For small rounded diamond strokes, Figma's SVG export collapses the side
  // corner arcs into mitered points. Rebuilding that centerline avoids the flat
  // caps created by a simple scaled copy of the fill path.
  return `M ${format(points[0].x)} ${format(points[0].y)} L ${format(points[1].x)} ${format(points[1].y)} L ${format(
    points[2].x
  )} ${format(points[2].y)} L ${format(points[3].x)} ${format(points[3].y)} Z`
}

function getStraightSegments(d: string): Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  const segments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = []
  let index = 0
  let current: { x: number; y: number } | null = null

  const readPoint = () => ({ x: Number(tokens[index++]), y: Number(tokens[index++]) })

  while (index < tokens.length) {
    const command = tokens[index++]
    if (command === "M") {
      current = readPoint()
    } else if (command === "L" && current) {
      const next = readPoint()
      segments.push({ from: current, to: next })
      current = next
    } else if (command === "Q") {
      index += 2
      current = readPoint()
    } else if (command === "C") {
      index += 4
      current = readPoint()
    } else if (command === "Z") {
      break
    }
  }

  const first = segments[0]
  const last = segments[segments.length - 1]
  if (first && last && getPointDistance(first.from, last.to) < 0.001) {
    segments.pop()
  }

  return segments
}

function getPointDistance(first: { x: number; y: number }, second: { x: number; y: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function getSignedArea(points: Array<{ x: number; y: number }>): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

function offsetLine(from: { x: number; y: number }, to: { x: number; y: number }, distance: number, ccw: boolean) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length < Number.EPSILON) return { from, dx, dy }

  const normal = ccw ? { x: -dy / length, y: dx / length } : { x: dy / length, y: -dx / length }
  return {
    from: { x: from.x + normal.x * distance, y: from.y + normal.y * distance },
    dx,
    dy
  }
}

function intersectLines(
  first: { from: { x: number; y: number }; dx: number; dy: number },
  second: { from: { x: number; y: number }; dx: number; dy: number }
): { x: number; y: number } | null {
  const determinant = first.dx * second.dy - first.dy * second.dx
  if (Math.abs(determinant) < Number.EPSILON) return null

  const t =
    ((second.from.x - first.from.x) * second.dy - (second.from.y - first.from.y) * second.dx) / determinant
  return {
    x: first.from.x + first.dx * t,
    y: first.from.y + first.dy * t
  }
}

function getStrokeAlignmentMatrix(bounds: Bounds, strokeWeight: number, strokeAlign?: FigNode["strokeAlign"]): SvgMatrix {
  if (strokeAlign !== "INSIDE" && strokeAlign !== "OUTSIDE") return IDENTITY

  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (width <= 0 || height <= 0) return IDENTITY

  const direction = strokeAlign === "INSIDE" ? -1 : 1
  const scaleX = Math.max(0.001, (width + direction * strokeWeight) / width)
  const scaleY = Math.max(0.001, (height + direction * strokeWeight) / height)
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2

  // Figma's SVG export moves inside/outside stroke centerlines instead of
  // filling the decoded stroke outline. Scaling around the geometry center is
  // a compact approximation that matches isometric icon bases much better.
  return [
    scaleX,
    0,
    0,
    scaleY,
    centerX - centerX * scaleX,
    centerY - centerY * scaleY
  ]
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
      const stroke = paintToSvgFill(context, node, bounds, paint, IDENTITY)
      const opacity = paintOpacityAttribute("stroke", paint)
      const rx = node.size!.x / 2 + strokeWeight / 2
      const ry = node.size!.y / 2 + strokeWeight / 2
      const transform = matrixToAttribute(matrix)

      // Figma's strokeGeometry for OUTSIDE ellipses is an expanded filled
      // outline. Using it directly paints inward and erases the ring gap, so
      // complete ellipses are emitted as actual outside strokes.
      return `<ellipse cx="${format(node.size!.x / 2)}" cy="${format(node.size!.y / 2)}" rx="${format(
        rx
      )}" ry="${format(ry)}" fill="none" stroke="${stroke}" stroke-width="${format(
        strokeWeight
      )}"${opacity}${transform}/>`
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
    if (!isFiniteBounds(parsed.bounds) || !parsed.d) return []

    const transformedBounds = transformBounds(matrix, parsed.bounds)
    includeBounds(context, transformedBounds)
    const fillRule = geometry.windingRule === "ODD" ? ` fill-rule="evenodd"` : ""

    return paints
      .filter((paint) => paint.visible !== false)
      .map((paint) => {
        if (paint.type === "IMAGE") {
          return renderImageFill(context, node, parsed, paint, matrix, fillRule)
        }

        const fill = paintToSvgFill(context, node, parsed.bounds, paint, matrix)
        const opacity = paintOpacityAttribute("fill", paint)

        return `<path d="${transformPathData(parsed.d, matrix)}" fill="${fill}"${fillRule}${opacity}/>`
      })
  })
}

function renderCodeSnapshot(context: RenderContext, node: FigNode, matrix: SvgMatrix): string {
  const snapshot = node.type === "CODE_INSTANCE" ? node.codeSnapshot : undefined
  const paints = snapshot?.paints?.filter((paint) => paint.visible !== false)
  const size = snapshot?.layoutSize ?? snapshot?.canvasSize ?? node.size
  if (!paints?.length || !size || size.x <= 0 || size.y <= 0) return ""

  const offset = snapshot?.offset ?? { x: 0, y: 0 }
  const bounds = {
    minX: offset.x,
    minY: offset.y,
    maxX: offset.x + size.x,
    maxY: offset.y + size.y
  }
  const parsed = {
    d: createRectPath(bounds),
    bounds
  }

  includeBounds(context, transformBounds(matrix, bounds))

  // Figma Make stores rendered code components as CODE_INSTANCE.codeSnapshot
  // image paints instead of normal fillGeometry. Treat the snapshot as a local
  // rectangular paint source so Make prototypes export with their preview.
  return paints
    .map((paint) => {
      if (paint.type === "IMAGE") {
        return renderImageFill(context, node, parsed, paint, matrix, "")
      }

      const fill = paintToSvgFill(context, node, parsed.bounds, paint, matrix)
      const opacity = paintOpacityAttribute("fill", paint)
      return `<path d="${transformPathData(parsed.d, matrix)}" fill="${fill}"${opacity}/>`
    })
    .join("")
}

function createRectPath(bounds: Bounds): string {
  return `M ${format(bounds.minX)} ${format(bounds.minY)} L ${format(bounds.maxX)} ${format(
    bounds.minY
  )} L ${format(bounds.maxX)} ${format(bounds.maxY)} L ${format(bounds.minX)} ${format(bounds.maxY)} Z`
}

function renderImageFill(
  context: RenderContext,
  node: FigNode,
  parsed: ParsedPath,
  paint: FigPaint,
  matrix: SvgMatrix,
  fillRule: string
): string {
  const href = getImageDataUrl(context, paint)
  const clipId = nextId(context, "clip")
  const clipRule = fillRule ? fillRule.replace(" fill-rule=", " clip-rule=") : ""
  const transformedPath = transformPathData(parsed.d, matrix)
  const imageMatrix = getImagePaintMatrix(node, parsed.bounds, paint, matrix)
  const opacity = imageOpacityAttribute(paint)

  context.defs.push(`<clipPath id="${clipId}"><path d="${transformedPath}"${clipRule}/></clipPath>`)

  // Figma stores image crop/fill as a normalized transform on the paint. Keep
  // the clip on a wrapper <g>; resvg can drop the bitmap when clip-path is put
  // directly on a transformed unit-sized <image>.
  return `<g clip-path="url(#${clipId})"><image href="${href}" width="1" height="1" preserveAspectRatio="none" transform="matrix(${imageMatrix
    .map(format)
    .join(" ")})"${opacity}/></g>`
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
  let hasOpenSubpath = false
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
      hasOpenSubpath = true
    } else if (command === COMMAND_LINE) {
      d += `L ${readPoint()} `
    } else if (command === COMMAND_QUADRATIC) {
      d += `Q ${readPoint()} ${readPoint()} `
    } else if (command === COMMAND_CUBIC) {
      d += `C ${readPoint()} ${readPoint()} ${readPoint()} `
    } else if (command === COMMAND_CLOSE) {
      if (hasOpenSubpath) {
        d += "Z "
        hasOpenSubpath = false
      }
    } else {
      throw new Error(`几何数据 blob ${blobIndex} 中存在不支持的向量命令：${command}`)
    }
  }

  return { d: d.trim(), bounds }
}

function transformPathData(d: string, matrix: SvgMatrix): string {
  if (matrix === IDENTITY) return d

  const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  const output: string[] = []
  let index = 0

  const readNumber = () => Number(tokens[index++])
  const readPoint = () => applyToPoint(matrix, readNumber(), readNumber())
  const writePoint = (point: { x: number; y: number }) => `${format(point.x)} ${format(point.y)}`

  while (index < tokens.length) {
    const command = tokens[index++]
    if (command === "M" || command === "L") {
      output.push(`${command} ${writePoint(readPoint())}`)
    } else if (command === "Q") {
      output.push(`Q ${writePoint(readPoint())} ${writePoint(readPoint())}`)
    } else if (command === "C") {
      output.push(`C ${writePoint(readPoint())} ${writePoint(readPoint())} ${writePoint(readPoint())}`)
    } else if (command === "Z") {
      output.push("Z")
    }
  }

  return output.join(" ")
}

function paintToSvgFill(
  context: RenderContext,
  node: FigNode,
  pathBounds: Bounds,
  paint: FigPaint,
  matrix: SvgMatrix
): string {
  if (paint.type === "SOLID") {
    return colorToCss(paint.color)
  }

  if (paint.type === "GRADIENT_LINEAR") {
    const id = nextId(context, "gradient")
    const gradient = getLinearGradientLine(node, pathBounds, paint, matrix)
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

  if (paint.type === "GRADIENT_RADIAL") {
    const id = nextId(context, "gradient")
    const gradientMatrix = getRadialGradientMatrix(node, pathBounds, paint, matrix)
    const stops = paint.stops
      ?.map(
        (stop) =>
          `<stop offset="${format(stop.position * 100)}%" stop-color="${colorToCss(stop.color)}" stop-opacity="${format(
            stop.color.a
          )}"/>`
      )
      .join("")

    context.defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${gradientMatrix
        .map(format)
        .join(" ")})">${stops ?? ""}</radialGradient>`
    )
    return `url(#${id})`
  }

  throw new Error(`不支持的填充类型：${paint.type}`)
}

function getLinearGradientLine(node: FigNode, pathBounds: Bounds, paint: FigPaint, matrix: SvgMatrix) {
  const width = node.size?.x || pathBounds.maxX - pathBounds.minX
  const height = node.size?.y || pathBounds.maxY - pathBounds.minY
  const originX = pathBounds.minX < 0 ? pathBounds.minX : 0
  const originY = pathBounds.minY < 0 ? pathBounds.minY : 0
  const inverse = invert(toSvgMatrix(paint.transform))

  // Figma's stored gradient transform maps local object space back into the
  // unit gradient space, so SVG needs the inverse projected onto the node box.
  const start = applyToPoint(inverse, 0, 0)
  const end = applyToPoint(inverse, 1, 0)
  const transformedStart = applyToPoint(matrix, originX + start.x * width, originY + start.y * height)
  const transformedEnd = applyToPoint(matrix, originX + end.x * width, originY + end.y * height)

  return {
    x1: transformedStart.x,
    y1: transformedStart.y,
    x2: transformedEnd.x,
    y2: transformedEnd.y
  }
}

function getRadialGradientMatrix(node: FigNode, pathBounds: Bounds, paint: FigPaint, matrix: SvgMatrix): SvgMatrix {
  const width = node.size?.x || pathBounds.maxX - pathBounds.minX
  const height = node.size?.y || pathBounds.maxY - pathBounds.minY
  const originX = pathBounds.minX < 0 ? pathBounds.minX : 0
  const originY = pathBounds.minY < 0 ? pathBounds.minY : 0
  const inverse = invert(toSvgMatrix(paint.transform))
  const center = applyToPoint(inverse, 0, 0)
  const xEdge = applyToPoint(inverse, 1, 0)
  const yEdge = applyToPoint(inverse, 0, 1)
  const localMatrix: SvgMatrix = [
    (xEdge.x - center.x) * width,
    (xEdge.y - center.y) * height,
    (yEdge.x - center.x) * width,
    (yEdge.y - center.y) * height,
    originX + center.x * width,
    originY + center.y * height
  ]

  // Radial gradients use the same normalized paint transform as linear
  // gradients, but SVG needs that unit circle projected into user space.
  return multiply(matrix, localMatrix)
}

function getImageDataUrl(context: RenderContext, paint: FigPaint): string {
  const candidates = [hashToHex(paint.image?.hash), hashToHex(paint.imageThumbnail?.hash)].filter(Boolean) as string[]
  for (const hash of candidates) {
    const asset = context.imageAssets.get(hash)
    if (asset) return asset
  }

  throw new Error(`不支持的 IMAGE 填充：找不到本地图片资源 ${candidates.join(" 或 ") || "unknown"}`)
}

function getImagePaintMatrix(node: FigNode, pathBounds: Bounds, paint: FigPaint, matrix: SvgMatrix): SvgMatrix {
  const width = node.size?.x || pathBounds.maxX - pathBounds.minX
  const height = node.size?.y || pathBounds.maxY - pathBounds.minY
  const originX = pathBounds.minX < 0 ? pathBounds.minX : 0
  const originY = pathBounds.minY < 0 ? pathBounds.minY : 0
  const transform = paint.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }
  const imageMatrix: SvgMatrix = [
    transform.m00 * width,
    transform.m10 * height,
    transform.m01 * width,
    transform.m11 * height,
    originX + transform.m02 * width,
    originY + transform.m12 * height
  ]

  return multiply(matrix, imageMatrix)
}

function hashToHex(hash: Uint8Array | number[] | string | Record<string, number> | undefined): string | null {
  if (!hash) return null
  if (typeof hash === "string") return hash.toLowerCase()

  const values =
    hash instanceof Uint8Array
      ? [...hash]
      : Array.isArray(hash)
        ? hash
        : Object.keys(hash)
            .sort((left, right) => Number(left) - Number(right))
            .map((key) => (hash as Record<string, number>)[key])

  return values.map((value) => value.toString(16).padStart(2, "0")).join("")
}

function createFilter(context: RenderContext, effects: FigEffect[] | undefined, bounds: Bounds): string | null {
  const shadow = effects?.find((effect) => effect.visible !== false && effect.type === "DROP_SHADOW")
  const innerShadows = effects?.filter((effect) => effect.visible !== false && effect.type === "INNER_SHADOW") ?? []
  const layerBlur = effects?.find(
    (effect) => effect.visible !== false && (effect.type === "FOREGROUND_BLUR" || effect.type === "LAYER_BLUR")
  )
  if (!shadow && !innerShadows.length && !layerBlur) return null

  const id = nextId(context, "shadow")
  const shadowRadius = shadow?.radius ?? 0
  const blurRadius = layerBlur?.radius ?? 0
  const spread = shadow?.spread ?? 0
  const offsetX = shadow?.offset?.x ?? 0
  const offsetY = shadow?.offset?.y ?? 0
  const filterPadding = Math.max(shadowRadius + Math.abs(spread), blurRadius)
  const x = bounds.minX + Math.min(0, offsetX) - filterPadding
  const y = bounds.minY + Math.min(0, offsetY) - filterPadding
  const width = bounds.maxX - bounds.minX + Math.abs(offsetX) + filterPadding * 2
  const height = bounds.maxY - bounds.minY + Math.abs(offsetY) + filterPadding * 2
  const sourceAlpha = shadow && spread
    ? `<feMorphology in="SourceAlpha" operator="${spread > 0 ? "dilate" : "erode"}" radius="${format(
        Math.abs(spread)
      )}" result="spreadAlpha"/>`
    : ""
  const blurInput = spread ? "spreadAlpha" : "SourceAlpha"
  const shadowResult = shadow?.showShadowBehindNode === false ? "visibleShadow" : "shadow"
  const hideShadowBehindSource =
    shadow?.showShadowBehindNode === false
      ? `<feComposite in="shadow" in2="SourceAlpha" operator="out" result="visibleShadow"/>`
      : ""
  const layerBlurMarkup = layerBlur
    ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${format(blurRadius / 2)}" result="layerBlur"/>`
    : ""
  const sourceGraphicResult = layerBlur ? "layerBlur" : "SourceGraphic"
  const shadowMarkup = shadow
    ? `${sourceAlpha}<feGaussianBlur in="${blurInput}" stdDeviation="${format(
        shadowRadius / 2
      )}" result="blurredShadow"/><feOffset in="blurredShadow" dx="${format(offsetX)}" dy="${format(
        offsetY
      )}" result="offsetShadow"/><feFlood flood-color="${colorToCss(shadow.color)}" flood-opacity="${format(
        shadow.color?.a ?? 1
      )}" result="shadowColor"/><feComposite in="shadowColor" in2="offsetShadow" operator="in" result="shadow"/>${hideShadowBehindSource}`
    : ""
  const shadowMergeNode = shadow ? `<feMergeNode in="${shadowResult}"/>` : ""
  let innerShadowMarkup = ""
  let sourceWithInnerShadows = sourceGraphicResult
  innerShadows.forEach((innerShadow, index) => {
    const result = `innerShadowShape-${index}`
    innerShadowMarkup += context.pngFigmaLike
      ? createFigmaLikeInnerShadowMarkup(innerShadow, index, sourceWithInnerShadows, result)
      : createInnerShadowMarkup(innerShadow, index, sourceWithInnerShadows, result)
    sourceWithInnerShadows = result
  })

  // Figma can combine outside-only shadows with layer blur on one node. Keep
  // both effects in a single filter so the layer order matches Figma export.
  context.defs.push(
    `<filter id="${id}" x="${format(x)}" y="${format(y)}" width="${format(width)}" height="${format(
      height
    )}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${shadowMarkup}${layerBlurMarkup}${innerShadowMarkup}<feMerge>${shadowMergeNode}<feMergeNode in="${sourceWithInnerShadows}"/></feMerge></filter>`
  )

  return id
}

function createFigmaLikeInnerShadowMarkup(effect: FigEffect, index: number, shapeInput: string, result: string): string {
  const radius = effect.radius ?? 0
  const spread = effect.spread ?? 0
  const offsetX = effect.offset?.x ?? 0
  const offsetY = effect.offset?.y ?? 0
  const edgeRadius = Math.max(0.5, spread + 0.5 || radius * 0.25)
  const blurRadius = Math.max(0, radius * 0.2)
  const hardShape = `innerHardShape-${index}`
  const edgeResult = `innerEdge-${index}`
  const offsetResult = `innerEdgeOffset-${index}`
  const blurResult = `innerEdgeBlur-${index}`
  const clippedResult = `innerEdgeClip-${index}`
  const boostedResult = `innerEdgeBoost-${index}`
  const colorResult = `innerEdgeColor-${index}`
  const shadowResult = `innerFigmaLikeShadow-${index}`

  // Figma's native PNG path treats low-opacity source fills as a hard shape
  // when building inner-shadow coverage. resvg follows the SVG filter literally,
  // which overfills the center; this compensated edge band keeps the center
  // translucent and strengthens only the inside edge.
  return `<feComponentTransfer in="SourceAlpha" result="${hardShape}"><feFuncA type="linear" slope="20"/></feComponentTransfer><feMorphology in="${hardShape}" operator="erode" radius="${format(
    edgeRadius
  )}" result="${edgeResult}-eroded"/><feComposite in="${hardShape}" in2="${edgeResult}-eroded" operator="out" result="${edgeResult}"/><feOffset in="${edgeResult}" dx="${format(
    offsetX
  )}" dy="${format(offsetY)}" result="${offsetResult}"/><feGaussianBlur in="${offsetResult}" stdDeviation="${format(
    blurRadius
  )}" result="${blurResult}"/><feComposite in="${blurResult}" in2="${hardShape}" operator="in" result="${clippedResult}"/><feComponentTransfer in="${clippedResult}" result="${boostedResult}"><feFuncA type="linear" slope="1.2"/></feComponentTransfer><feFlood flood-color="${colorToCss(
    effect.color
  )}" flood-opacity="${format(effect.color?.a ?? 1)}" result="${colorResult}"/><feComposite in="${colorResult}" in2="${boostedResult}" operator="in" result="${shadowResult}"/><feBlend mode="normal" in="${shadowResult}" in2="${shapeInput}" result="${result}"/>`
}

function createInnerShadowMarkup(effect: FigEffect, index: number, shapeInput: string, result: string): string {
  const radius = effect.radius ?? 0
  const spread = effect.spread ?? 0
  const offsetX = effect.offset?.x ?? 0
  const offsetY = effect.offset?.y ?? 0
  const hardAlpha = `innerHardAlpha-${index}`
  const spreadResult = `innerSpread-${index}`
  const offsetResult = `innerOffset-${index}`
  const blurResult = `innerBlur-${index}`
  const shadowResult = `innerShadow-${index}`
  const source =
    spread !== 0
      ? `<feMorphology in="SourceAlpha" operator="${spread > 0 ? "erode" : "dilate"}" radius="${format(
          Math.abs(spread)
        )}" result="${spreadResult}"/>`
      : ""
  const sourceInput = spread !== 0 ? spreadResult : "SourceAlpha"

  // Figma's own SVG export builds inner shadows with hardAlpha and arithmetic
  // compositing; using a simpler mask changes the edge strength noticeably.
  return `<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="${hardAlpha}"/>${source}<feOffset in="${sourceInput}" dx="${format(
    offsetX
  )}" dy="${format(offsetY)}" result="${offsetResult}"/><feGaussianBlur in="${offsetResult}" stdDeviation="${format(
    radius / 2
  )}" result="${blurResult}"/><feComposite in="${blurResult}" in2="${hardAlpha}" operator="arithmetic" k2="-1" k3="1" result="${shadowResult}"/><feColorMatrix in="${shadowResult}" type="matrix" values="${colorMatrixValues(
    effect.color
  )}" result="${shadowResult}-color"/><feBlend mode="normal" in="${shadowResult}-color" in2="${shapeInput}" result="${result}"/>`
}

function createNodeEffectFilter(context: RenderContext, node: FigNode, matrix: SvgMatrix): string | null {
  const localBounds = getNodeLocalBounds(context, node)
  if (!localBounds) return null
  const effects = shouldRenderFigmaLikeEllipseInnerShadowOverlay(context, node)
    ? node.effects?.filter((effect) => effect.type !== "INNER_SHADOW")
    : node.effects

  // Effects belong to the Figma layer itself. Frames/groups can carry shadows
  // even when their own fill paints are empty, so the filter must wrap the
  // rendered layer content instead of only individual geometry paths.
  const filterId = createFilter(context, effects, transformBounds(matrix, localBounds))
  if (!filterId) return null

  const expandedBounds = transformBounds(matrix, expandBoundsForEffects(localBounds, effects))
  includeBounds(context, expandedBounds)
  includeEffectBounds(context, expandedBounds)
  return filterId
}

function shouldRenderFigmaLikeEllipseInnerShadowOverlay(context: RenderContext, node: FigNode): boolean {
  return Boolean(
    context.pngFigmaLike &&
      node.type === "ELLIPSE" &&
      node.size &&
      isFullEllipse(node.arcData) &&
      node.effects?.some((effect) => effect.visible !== false && effect.type === "INNER_SHADOW")
  )
}

function collectFigmaLikeEllipseInnerShadowHint(context: RenderContext, node: FigNode, matrix: SvgMatrix): string {
  if (!shouldRenderFigmaLikeEllipseInnerShadowOverlay(context, node) || !node.size) return ""

  const innerShadow = node.effects?.find((effect) => effect.visible !== false && effect.type === "INNER_SHADOW")
  if (!innerShadow) return ""

  const rx = node.size.x / 2
  const ry = node.size.y / 2
  const cx = rx
  const cy = ry
  const minRadius = Math.max(1, Math.min(rx, ry))
  const radius = innerShadow.radius ?? 0
  const spread = innerShadow.spread ?? 0
  const color = innerShadow.color ?? { r: 0, g: 0, b: 0, a: 1 }

  // Figma's native PNG renderer builds inner-shadow coverage from the vector
  // ellipse itself, not from the low-opacity SVG SourceAlpha filter input.
  // Record a raster hint so export-node can apply the edge falloff directly to
  // pixels after SVG rasterization, bypassing backend-specific filter behavior.
  context.rasterHints.push({
    type: "ellipse-inner-shadow",
    matrix,
    cx,
    cy,
    rx,
    ry,
    color,
    opacity: color.a,
    spread: Math.max(0, Math.min(minRadius - 0.5, spread)),
    blurSigma: Math.max(0.5, Math.min(minRadius, radius * 0.42))
  })

  return ""
}

function getRootExportBounds(target: FigNode, renderedBounds: Bounds | null, effectBounds: Bounds | null): Bounds {
  if (target.size) {
    const targetBounds = {
      minX: 0,
      minY: 0,
      maxX: target.size.x,
      maxY: target.size.y
    }

    // Native exports keep the node's nominal box, then extend the bitmap when
    // visible filters such as foreground blur reach outside that box.
    if (shouldUseNominalRootBounds(target)) return targetBounds

    return effectBounds ? unionBounds(targetBounds, effectBounds) : targetBounds
  }

  return renderedBounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}

function shouldUseNominalRootBounds(target: FigNode): boolean {
  return Boolean(target.exportSettings?.some((setting) => setting.useAbsoluteBounds === false))
}

function getFigmaPixelSize(size: number, scale: number): number {
  const raw = size * scale
  const rounded = Math.round(raw)

  // Figma files often contain tiny float noise around integer layer sizes. The
  // native export uses the intended integer in those cases, but still expands
  // genuinely fractional selections so artwork is not clipped.
  if (Math.abs(raw - rounded) < 0.01) return Math.max(1, rounded)

  return Math.max(1, Math.ceil(raw))
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
    // Some imported component assets keep stale fillGeometry blob references
    // for invisible fills. Bounds should come from any remaining valid geometry
    // instead of failing before visible strokeGeometry can render.
    const parsed = tryParsePathBlob(context.figJson, geometry.commandsBlob)
    if (!parsed || !isFiniteBounds(parsed.bounds)) continue

    bounds = bounds ? unionBounds(bounds, parsed.bounds) : { ...parsed.bounds }
  }

  return bounds && Number.isFinite(bounds.minX) ? bounds : null
}

function getSortedChildren(context: RenderContext, node: FigNode): FigNode[] {
  return [...(context.childrenByParent.get(keyForGuid(node.guid)) ?? [])].sort((a, b) =>
    comparePosition(a.parentIndex?.position ?? "", b.parentIndex?.position ?? "")
  )
}

function comparePosition(left: string, right: string): number {
  // parentIndex.position is a fractional-index string; locale-aware sorting
  // reorders punctuation and changes Figma's z-order.
  if (left === right) return 0
  return left < right ? -1 : 1
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

function isFiniteBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.maxY) &&
    bounds.maxX >= bounds.minX &&
    bounds.maxY >= bounds.minY
  )
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount
  }
}

function expandBoundsForEffects(bounds: Bounds, effects: FigEffect[] | undefined): Bounds {
  const next = { ...bounds }
  for (const effect of effects ?? []) {
    if (effect.visible === false) continue

    if (effect.type === "FOREGROUND_BLUR" || effect.type === "LAYER_BLUR") {
      const radius = effect.radius ?? 0
      next.minX = Math.min(next.minX, bounds.minX - radius)
      next.maxX = Math.max(next.maxX, bounds.maxX + radius)
      next.minY = Math.min(next.minY, bounds.minY - radius)
      next.maxY = Math.max(next.maxY, bounds.maxY + radius)
      continue
    }

    if (effect.type !== "DROP_SHADOW") continue

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

function includeEffectBounds(context: RenderContext, bounds: Bounds) {
  context.effectBounds = context.effectBounds ? unionBounds(context.effectBounds, bounds) : { ...bounds }
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

function colorMatrixValues(color?: FigColor): string {
  const next = color ?? { r: 0, g: 0, b: 0, a: 1 }
  return [
    0,
    0,
    0,
    0,
    next.r,
    0,
    0,
    0,
    0,
    next.g,
    0,
    0,
    0,
    0,
    next.b,
    0,
    0,
    0,
    next.a,
    0
  ]
    .map(format)
    .join(" ")
}

function paintOpacityAttribute(kind: "fill" | "stroke", paint: FigPaint): string {
  const opacity = (paint.opacity ?? 1) * (paint.type === "SOLID" ? paint.color?.a ?? 1 : 1)
  return opacity !== 1 ? ` ${kind}-opacity="${format(opacity)}"` : ""
}

function imageOpacityAttribute(paint: FigPaint): string {
  const opacity = paint.opacity ?? 1
  return opacity !== 1 ? ` opacity="${format(opacity)}"` : ""
}

function strokeDashArrayAttribute(node: FigNode): string {
  const dashPattern = node.dashPattern?.filter((value) => value > 0)
  if (!dashPattern?.length) return ""

  // Figma preserves dashed strokes as stroke metadata. Emitting dasharray keeps
  // the semantic dashed stroke instead of rasterizing it from baked contours.
  return ` stroke-dasharray="${dashPattern.map(format).join(" ")}"`
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
