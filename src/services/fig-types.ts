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
  arcData?: FigArcData
  fillPaints?: FigPaint[]
  strokePaints?: FigPaint[]
  fillGeometry?: FigGeometry[]
  strokeGeometry?: FigGeometry[]
  effects?: FigEffect[]
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
