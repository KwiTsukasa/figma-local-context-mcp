import fs from "node:fs"
import path from "node:path"
import UzipModule from "uzip"

const UZIP = (UzipModule as any).default ?? UzipModule

export type FigImageAssets = Map<string, string>

export function loadFigImageAssets(filePath: string): FigImageAssets {
  const absolutePath = path.resolve(filePath)
  if (absolutePath.toLowerCase().endsWith(".json")) return new Map()

  const fileBytes = fs.readFileSync(absolutePath)
  if (!isZipFile(fileBytes)) return new Map()

  const unzipped = UZIP.parse(toArrayBuffer(fileBytes))
  const assets: FigImageAssets = new Map()

  for (const [entryName, entryBytes] of Object.entries(unzipped) as Array<[string, Uint8Array]>) {
    if (!entryName.startsWith("images/") || entryName.endsWith("/")) continue

    const hash = path.posix.basename(entryName).toLowerCase()
    const mimeType = detectImageMimeType(entryBytes)
    if (!mimeType) continue

    assets.set(hash, `data:${mimeType};base64,${Buffer.from(entryBytes).toString("base64")}`)
  }

  return assets
}

function detectImageMimeType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }

  return null
}

function isZipFile(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
