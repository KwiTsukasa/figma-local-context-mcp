import { ByteBuffer, compileSchema, decodeBinarySchema } from "kiwi-schema"
import { decompress as decompressZstd } from "fzstd"
import UzipModule from "uzip"
import type { FigJson } from "./fig-types.js"

const UZIP = (UzipModule as any).default ?? UzipModule
const FIGMA_TO_JSON_METADATA_KEY = "__figmaToJson"
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const PNG_MAGIC = [137, 80, 78, 71]

type FigmaBinaryParts = {
  delimiter: number
  parts: Uint8Array<ArrayBufferLike>[]
}

export function figToJson(fileBuffer: Uint8Array | ArrayBuffer): FigJson {
  const { delimiter, parts } = figToBinaryParts(fileBuffer)
  assertFigmaParts(parts)
  const [schemaByte, dataByte] = parts

  const schema = decodeBinarySchema(new ByteBuffer(schemaByte))
  const dataBB = new ByteBuffer(dataByte)
  const schemaHelper = compileSchema(schema)
  const json = schemaHelper.decodeMessage(dataBB) as FigJson

  return {
    ...convertBlobsToBase64(json),
    [FIGMA_TO_JSON_METADATA_KEY]: {
      schema: bytesToBase64(schemaByte),
      delimiter
    }
  }
}

function figToBinaryParts(fileBuffer: Uint8Array | ArrayBuffer): FigmaBinaryParts {
  let fileByte: Uint8Array<ArrayBufferLike> = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer)

  if (!isKiwiFile(fileByte)) {
    const unzipped = UZIP.parse(toArrayBuffer(fileByte))
    const canvas = unzipped["canvas.fig"]
    if (!canvas) {
      throw new Error("未找到 canvas.fig，文件可能不是有效的 .fig")
    }
    fileByte = new Uint8Array(canvas.buffer, canvas.byteOffset, canvas.byteLength)
  }

  let start = 8
  const delimiter = readUint32(fileByte, start)
  start += 4

  const parts: Uint8Array<ArrayBufferLike>[] = []
  while (start < fileByte.length) {
    const size = readUint32(fileByte, start)
    start += 4

    let part: Uint8Array<ArrayBufferLike> = fileByte.slice(start, start + size)
    if (startsWith(part, ZSTD_MAGIC)) {
      part = decompressZstd(part)
    } else if (!startsWith(part, PNG_MAGIC)) {
      part = UZIP.inflateRaw(part)
    }

    parts.push(part)
    start += size
  }

  return { delimiter, parts }
}

function convertBlobsToBase64(json: FigJson): FigJson {
  const blobs = (json as any).blobs
  if (!Array.isArray(blobs)) return json

  return {
    ...json,
    blobs: blobs.map((blob: any) => bytesToBase64(blob.bytes ?? blob))
  }
}

function assertFigmaParts(parts: Uint8Array[]): void {
  if (parts.length < 2) {
    throw new Error("fig 文件缺少 schema 或 data 数据段")
  }
}

function isKiwiFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && String.fromCharCode(...bytes.slice(0, 8)) === "fig-kiwi"
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((value, index) => bytes[index] === value)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
}

function toArrayBuffer(bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
