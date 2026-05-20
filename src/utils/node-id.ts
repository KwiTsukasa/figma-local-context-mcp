import type { Guid } from "../services/fig-types.js"

export function keyForGuid(guid?: Guid): string {
  return guid ? `${guid.sessionID}:${guid.localID}` : ""
}

export function normalizeNodeId(value?: string): string | null {
  if (!value) return null

  const text = safeDecodeURIComponent(value.trim())
  const nodeIdParam = text.match(/(?:^|[?&#\s])node-id=([^&#\s]+)/i)?.[1]
  const candidate = safeDecodeURIComponent(nodeIdParam ?? text).trim()
  const match = candidate.match(/^(\d+)[:\-](\d+)$/)

  if (!match) return null

  return `${match[1]}:${match[2]}`
}

export function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-").replace(/^-|-$/g, "") || "node"
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
