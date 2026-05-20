import fs from "node:fs"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { loadFigFile } from "./fig-file.js"
import { renderNodeToSvg } from "./fig-node-svg.js"
import { keyForGuid, sanitizeFilePart } from "../utils/node-id.js"

export type ExportNodeOptions = {
  filePath: string
  nodeQuery: string
  outputPath?: string
  format: "svg" | "png"
  scale: number
  background?: string
}

export type ExportNodeResult = {
  filePath: string
  outputPath: string
  format: "svg" | "png"
  scale: number
  width: number
  height: number
  node: {
    id: string
    name?: string
    type?: string
  }
}

export function exportFigNode(options: ExportNodeOptions): ExportNodeResult {
  const figJson = loadFigFile(options.filePath)
  const rendered = renderNodeToSvg(figJson, {
    nodeQuery: options.nodeQuery,
    scale: options.scale,
    background: options.background
  })
  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath(options))

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  if (options.format === "svg") {
    fs.writeFileSync(outputPath, rendered.svg)
  } else {
    fs.writeFileSync(outputPath, new Resvg(rendered.svg).render().asPng())
  }

  return {
    filePath: path.resolve(options.filePath),
    outputPath,
    format: options.format,
    scale: options.scale,
    width: rendered.width,
    height: rendered.height,
    node: {
      id: keyForGuid(rendered.node.guid),
      name: rendered.node.name,
      type: rendered.node.type
    }
  }
}

function defaultOutputPath(options: ExportNodeOptions): string {
  const input = path.parse(options.filePath)
  const nodePart = sanitizeFilePart(options.nodeQuery)
  const scalePart = options.format === "png" ? `@${options.scale}x` : ""
  return path.join(process.cwd(), `${input.name}-${nodePart}${scalePart}.${options.format}`)
}
