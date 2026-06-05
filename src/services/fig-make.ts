import fs from "node:fs"
import path from "node:path"
import UzipModule from "uzip"
import type { FigJson, FigNode, FigPaint, Guid } from "./fig-types.js"
import { loadFigFile, summarizeNode } from "./fig-file.js"
import { getChildrenByParent } from "./fig-node-svg.js"
import { keyForGuid } from "../utils/node-id.js"

const UZIP = (UzipModule as any).default ?? UzipModule

type ZipEntries = Record<string, Uint8Array>

type RawAiChat = {
  threads?: RawAiThread[]
}

type RawAiThread = {
  id?: string
  threadType?: string
  title?: string | null
  createdAt?: string
  updatedAt?: string
  messages?: RawAiMessage[]
}

type RawAiMessage = {
  id?: string
  index?: number
  role?: string
  createdAt?: string
  updatedAt?: string
  parts?: RawAiPart[]
}

type RawAiPart = {
  partType?: string
  contentJson?: string
  blobstoreContentKey?: string
}

export type MakeContextOptions = {
  includeSource?: boolean
  sourceMaxLength?: number
  fileQuery?: string
  includeAiChat?: boolean
  maxMessages?: number
}

export function getMakeContext(filePath: string, options: MakeContextOptions = {}) {
  const absolutePath = path.resolve(filePath)
  const figJson = loadFigFile(absolutePath)
  const entries = tryLoadZipEntries(absolutePath)
  const meta = readJsonEntry(entries, "meta.json")
  const aiChat = readJsonEntry<RawAiChat>(entries, "ai_chat.json")
  const childrenByParent = getChildrenByParent(figJson)
  const nodes = figJson.nodeChanges ?? []
  const allCodeFiles = collectCodeFiles(figJson, { includeSource: false })
  const codeFiles = collectCodeFiles(figJson, options)
  const codeComponents = collectCodeComponents(figJson, allCodeFiles)
  const codeInstances = collectCodeInstances(figJson, codeComponents)
  const canvasMagic = getCanvasMagic(entries)
  const isMakeFile =
    path.extname(absolutePath).toLowerCase() === ".make" ||
    canvasMagic === "fig-make" ||
    Boolean(entries?.["ai_chat.json"]) ||
    nodes.some((node) => node.type?.startsWith("CODE_") || node.type === "RESPONSIVE_SET")

  return {
    kind: "figma-make-context",
    filePath: absolutePath,
    isMakeFile,
    canvasMagic,
    entries: summarizeEntries(entries),
    meta,
    document: {
      nodeCount: nodes.length,
      blobCount: figJson.blobs?.length ?? 0,
      topTypes: getTopTypes(figJson),
      root: summarizeRootNode(figJson, childrenByParent)
    },
    code: {
      fileCount: nodes.filter((node) => node.type === "CODE_FILE").length,
      componentCount: codeComponents.length,
      instanceCount: codeInstances.length,
      files: codeFiles,
      components: codeComponents,
      instances: codeInstances
    },
    aiChat: options.includeAiChat === false ? undefined : summarizeAiChat(aiChat, options.maxMessages ?? 20)
  }
}

function collectCodeFiles(figJson: FigJson, options: MakeContextOptions) {
  const query = options.fileQuery?.trim().toLowerCase()
  const includeSource = options.includeSource ?? false
  const sourceMaxLength = Math.max(0, options.sourceMaxLength ?? 20000)

  return (figJson.nodeChanges ?? [])
    .filter((node) => node.type === "CODE_FILE")
    .map((node) => {
      const id = keyForGuid(node.guid)
      const filePath = node.codeFilePath ?? node.name
      const sourceCode = node.sourceCode ?? ""
      return {
        id,
        name: node.name,
        path: filePath,
        language: inferLanguage(filePath) ?? inferLanguage(node.name),
        sourceLength: sourceCode.length,
        importedCodeFileCount: node.importedCodeFiles?.length ?? 0,
        ...includeSourcePreview(sourceCode, includeSource, sourceMaxLength)
      }
    })
    .filter((file) => {
      if (!query) return true
      return [file.id, file.name, file.path, file.language].some((value) => value?.toLowerCase().includes(query))
    })
}

function collectCodeComponents(figJson: FigJson, codeFiles: Array<{ id: string; name?: string; path?: string }>) {
  const codeFileById = new Map(codeFiles.map((file) => [file.id, file]))

  return (figJson.nodeChanges ?? [])
    .filter((node) => node.type === "CODE_COMPONENT")
    .map((node) => {
      const exportedFromCodeFileId = keyForReference(node.exportedFromCodeFileId)
      const codeFile = codeFileById.get(exportedFromCodeFileId)
      return {
        id: keyForGuid(node.guid),
        name: node.name,
        exportedFromCodeFileId,
        exportedFromCodeFileName: codeFile?.name,
        exportedFromCodeFilePath: codeFile?.path,
        codeExportName: node.codeExportName,
        propCount: node.componentPropDefs?.length ?? 0
      }
    })
}

function collectCodeInstances(figJson: FigJson, codeComponents: Array<{ id: string; name?: string }>) {
  const componentById = new Map(codeComponents.map((component) => [component.id, component]))

  return (figJson.nodeChanges ?? [])
    .filter((node) => node.type === "CODE_INSTANCE")
    .map((node) => {
      const backingCodeComponentId = keyForReference(node.backingCodeComponentId)
      const component = componentById.get(backingCodeComponentId)
      return {
        id: keyForGuid(node.guid),
        name: node.name,
        codeFilePath: node.codeFilePath,
        backingCodeComponentId,
        backingCodeComponentName: component?.name,
        snapshotState: node.codeSnapshot?.state,
        snapshotLayoutSize: node.codeSnapshot?.layoutSize,
        snapshotCanvasSize: node.codeSnapshot?.canvasSize,
        snapshotDevicePixelRatio: node.codeSnapshot?.devicePixelRatio,
        previewImageHashes: getPaintImageHashes(node.codeSnapshot?.paints)
      }
    })
}

function summarizeAiChat(aiChat: RawAiChat | undefined, maxMessages: number) {
  const threads = aiChat?.threads ?? []
  return {
    threadCount: threads.length,
    messageCount: threads.reduce((count, thread) => count + (thread.messages?.length ?? 0), 0),
    threads: threads.map((thread) => ({
      id: thread.id,
      threadType: thread.threadType,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: thread.messages?.length ?? 0,
      messages: thread.messages?.slice(0, maxMessages).map(summarizeAiMessage) ?? []
    }))
  }
}

function summarizeAiMessage(message: RawAiMessage) {
  const parts = message.parts ?? []
  return {
    id: message.id,
    index: message.index,
    role: message.role,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    partTypes: parts.map((part) => part.partType).filter(Boolean),
    preview: getMessagePreview(parts)
  }
}

function getMessagePreview(parts: RawAiPart[]): string | undefined {
  for (const part of parts) {
    const content = parseJson(part.contentJson)
    const text = pickString(content, "text") ?? pickString(content, "title") ?? pickString(content, "resultJson")
    if (text) return text.length > 300 ? `${text.slice(0, 300)}...` : text
  }

  return undefined
}

function includeSourcePreview(sourceCode: string, includeSource: boolean, sourceMaxLength: number) {
  if (!includeSource) return {}

  const truncated = sourceCode.length > sourceMaxLength
  return {
    sourceCode: truncated ? sourceCode.slice(0, sourceMaxLength) : sourceCode,
    sourceTruncated: truncated
  }
}

function summarizeRootNode(figJson: FigJson, childrenByParent: Map<string, FigNode[]>) {
  const root =
    figJson.nodeChanges?.find((node) => node.type === "DOCUMENT") ??
    figJson.nodeChanges?.find((node) => !node.parentIndex?.guid) ??
    figJson.nodeChanges?.[0]

  return root ? summarizeNode(root, childrenByParent) : undefined
}

function summarizeEntries(entries: ZipEntries | null) {
  if (!entries) return undefined

  const names = Object.keys(entries)
  return {
    count: names.length,
    hasCanvas: Boolean(entries["canvas.fig"]),
    hasMeta: Boolean(entries["meta.json"]),
    hasAiChat: Boolean(entries["ai_chat.json"]),
    hasThumbnail: Boolean(entries["thumbnail.png"]),
    imageCount: names.filter((name) => name.startsWith("images/") && !name.endsWith("/")).length,
    blobStoreCount: names.filter((name) => name.startsWith("blob_store/") && !name.endsWith("/")).length,
    names: names.map((name) => ({ name, size: entries[name]?.length ?? 0 }))
  }
}

function getTopTypes(figJson: FigJson): Record<string, number> {
  const topTypes: Record<string, number> = {}
  for (const node of figJson.nodeChanges ?? []) {
    const type = node.type ?? "UNKNOWN"
    topTypes[type] = (topTypes[type] ?? 0) + 1
  }

  return Object.fromEntries(Object.entries(topTypes).sort((a, b) => b[1] - a[1]))
}

function getPaintImageHashes(paints: FigPaint[] | undefined): string[] {
  if (!Array.isArray(paints)) return []

  const hashes = new Set<string>()
  for (const paint of paints) {
    const imageHash = hashToHex(paint.image?.hash)
    const thumbnailHash = hashToHex(paint.imageThumbnail?.hash)
    if (imageHash) hashes.add(imageHash)
    if (thumbnailHash) hashes.add(thumbnailHash)
  }

  return [...hashes]
}

function keyForReference(reference: { guid: Guid } | undefined): string {
  return keyForGuid(reference?.guid)
}

function inferLanguage(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined

  const extension = path.extname(filePath).toLowerCase()
  const languages: Record<string, string> = {
    ".css": "css",
    ".html": "html",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".json": "json",
    ".md": "markdown",
    ".ts": "typescript",
    ".tsx": "typescriptreact"
  }

  return languages[extension] ?? (extension.replace(/^\./, "") || undefined)
}

function readJsonEntry<T = unknown>(entries: ZipEntries | null, entryName: string): T | undefined {
  const bytes = entries?.[entryName]
  if (!bytes) return undefined

  return parseJson(Buffer.from(bytes).toString("utf8")) as T | undefined
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined

  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function pickString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) return undefined

  const next = (value as Record<string, unknown>)[key]
  return typeof next === "string" ? next : undefined
}

function getCanvasMagic(entries: ZipEntries | null): string | undefined {
  const canvas = entries?.["canvas.fig"]
  if (!canvas || canvas.length < 8) return undefined

  return Buffer.from(canvas.subarray(0, 8)).toString("utf8")
}

function tryLoadZipEntries(filePath: string): ZipEntries | null {
  const bytes = fs.readFileSync(filePath)
  if (!isZipFile(bytes)) return null

  return UZIP.parse(toArrayBuffer(bytes)) as ZipEntries
}

function isZipFile(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
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
            .map((key) => hash[key])

  return values.map((value) => value.toString(16).padStart(2, "0")).join("")
}
