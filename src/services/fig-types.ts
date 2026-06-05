export type Guid = {
  sessionID: number
  localID: number
}

export type FigmaMatrix = {
  m00: number
  m01: number
  m02: number
  m10: number
  m11: number
  m12: number
}

export type FigArcData = {
  startingAngle?: number
  endingAngle?: number
  innerRadius?: number
}

export type FigColor = {
  r: number
  g: number
  b: number
  a: number
}

export type FigPaint = {
  type: "SOLID" | "GRADIENT_LINEAR" | string
  color?: FigColor
  opacity?: number
  visible?: boolean
  stops?: Array<{ color: FigColor; position: number }>
  transform?: FigmaMatrix
  image?: { hash?: Uint8Array | number[] | string; name?: string }
  imageThumbnail?: { hash?: Uint8Array | number[] | string; name?: string }
  imageScaleMode?: "FILL" | "FIT" | "STRETCH" | "TILE" | string
  originalImageWidth?: number
  originalImageHeight?: number
}

export type FigNodeReference = {
  guid: Guid
}

export type FigCodeSnapshot = {
  state?: string
  paints?: FigPaint[]
  offset?: { x: number; y: number }
  layoutSize?: { x: number; y: number }
  canvasSize?: { x: number; y: number }
  devicePixelRatio?: number
}

export type FigTextGlyph = {
  commandsBlob: number
  position?: { x: number; y: number }
  fontSize?: number
  firstCharacter?: number
  advance?: number
  rotation?: number
}

export type FigTextStyleOverride = {
  styleID?: number
  fillPaints?: FigPaint[]
  fontSize?: number
}

export type FigTextData = {
  characters?: string
  characterStyleIDs?: number[]
  styleOverrideTable?: FigTextStyleOverride[]
  lines?: unknown[]
}

export type FigDerivedTextData = {
  glyphs?: FigTextGlyph[]
  layoutSize?: { x: number; y: number }
  baselines?: Array<{
    position?: { x: number; y: number }
    width?: number
    lineY?: number
    lineHeight?: number
    lineAscent?: number
    firstCharacter?: number
    endCharacter?: number
  }>
}

export type FigGeometry = {
  commandsBlob: number
  windingRule?: string
  styleID?: number
}

export type FigEffect = {
  type: string
  visible?: boolean
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
  showShadowBehindNode?: boolean
  color?: FigColor
}

export type FigNode = {
  guid: Guid
  parentIndex?: { guid: Guid; position?: string }
  type?: string
  name?: string
  visible?: boolean
  opacity?: number
  size?: { x: number; y: number }
  transform?: FigmaMatrix
  strokeWeight?: number
  strokeAlign?: "CENTER" | "INSIDE" | "OUTSIDE"
  dashPattern?: number[]
  frameMaskDisabled?: boolean
  mask?: boolean
  maskType?: "OUTLINE" | "ALPHA" | string
  exportSettings?: Array<{ useAbsoluteBounds?: boolean; contentsOnly?: boolean; [key: string]: unknown }>
  arcData?: FigArcData
  fillPaints?: FigPaint[]
  strokePaints?: FigPaint[]
  fillGeometry?: FigGeometry[]
  strokeGeometry?: FigGeometry[]
  effects?: FigEffect[]
  fontSize?: number
  textData?: FigTextData
  derivedTextData?: FigDerivedTextData
  sourceCode?: string
  codeFilePath?: string
  importedCodeFiles?: unknown[]
  belongsToCodeLibraryId?: FigNodeReference
  exportedFromCodeFileId?: FigNodeReference
  codeExportName?: string
  backingCodeComponentId?: FigNodeReference
  codeSnapshot?: FigCodeSnapshot
  responsiveSetSettings?: unknown
  componentPropDefs?: unknown[]
}

export type FigJson = {
  type?: string
  sessionID?: number
  ackID?: number
  nodeChanges?: FigNode[]
  blobs?: string[]
  __figmaToJson?: {
    schema: string
    delimiter: number
  }
}

export type Bounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}
