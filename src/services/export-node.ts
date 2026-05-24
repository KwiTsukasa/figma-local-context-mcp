import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { Resvg } from "@resvg/resvg-js"
import { loadFigFile } from "./fig-file.js"
import { loadFigImageAssets } from "./fig-images.js"
import { renderNodeToSvg, type FigmaLikeRasterHint } from "./fig-node-svg.js"
import { keyForGuid, sanitizeFilePart } from "../utils/node-id.js"

export type PngRenderer = "figma-like" | "local-preview"

const MASK_SUPERSAMPLE = 8

export type ExportNodeOptions = {
  filePath: string
  nodeQuery: string
  outputPath?: string
  format: "svg" | "png"
  scale: number
  background?: string
  pngRenderer?: PngRenderer
}

export type ExportNodeResult = {
  filePath: string
  outputPath: string
  format: "svg" | "png"
  scale: number
  width: number
  height: number
  renderer: "local-svg" | "local-svg-resvg" | "local-figma-like-resvg"
  exportCapabilities: {
    localSvg: {
      supported: true
      renderer: "figma-local-context-mcp"
      source: "decoded-local-fig"
    }
    localPng: {
      supported: true
      renderer: "@resvg/resvg-js"
      source: "mcp-generated-svg"
      fidelity: "preview"
    }
    figmaLikePng: {
      supported: true
      renderer: "@resvg/resvg-js"
      source: "mcp-generated-svg-with-figma-like-filter-compensation"
      fidelity: "approximate"
    }
    figmaNativePng: {
      supported: false
      reason: string
    }
  }
  warnings?: string[]
  node: {
    id: string
    name?: string
    type?: string
  }
}

export function exportFigNode(options: ExportNodeOptions): ExportNodeResult {
  const figJson = loadFigFile(options.filePath)
  const imageAssets = loadFigImageAssets(options.filePath)
  const pngRenderer = options.pngRenderer ?? "figma-like"
  const useFigmaLikePng = options.format === "png" && pngRenderer === "figma-like"
  const rendered = renderNodeToSvg(figJson, {
    nodeQuery: options.nodeQuery,
    scale: options.scale,
    background: options.background,
    pngFigmaLike: useFigmaLikePng,
    imageAssets
  })
  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath(options))
  const node = {
    id: keyForGuid(rendered.node.guid),
    name: rendered.node.name,
    type: rendered.node.type
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  if (options.format === "svg") {
    fs.writeFileSync(outputPath, rendered.svg)
  } else {
    const image = new Resvg(rendered.svg).render()
    if (useFigmaLikePng && rendered.rasterHints.length) {
      const pixels = Buffer.from(image.pixels)
      unpremultiplyPixels(pixels)
      applyFigmaLikeRasterHints(pixels, rendered.width, rendered.height, rendered.viewBox, rendered.rasterHints)
      fs.writeFileSync(outputPath, encodeRgbaPng(rendered.width, rendered.height, pixels))
    } else {
      fs.writeFileSync(outputPath, image.asPng())
    }
  }

  const warnings =
    options.format === "png"
      ? [
          pngRenderer === "figma-like"
            ? "PNG 使用本地 figma-like 渲染：会对 Figma 内阴影/透明边缘做近似补偿，但仍不保证与 Figma 原生 PNG 像素级完全一致。"
            : "PNG 使用本地 SVG + @resvg/resvg-js 预览渲染，不保证与 Figma 原生 PNG 一致。"
        ]
      : undefined

  return {
    filePath: path.resolve(options.filePath),
    outputPath,
    format: options.format,
    scale: options.scale,
    width: rendered.width,
    height: rendered.height,
    renderer: options.format === "svg" ? "local-svg" : useFigmaLikePng ? "local-figma-like-resvg" : "local-svg-resvg",
    exportCapabilities: getExportCapabilities(),
    warnings,
    node
  }
}

function getExportCapabilities(): ExportNodeResult["exportCapabilities"] {
  return {
    localSvg: {
      supported: true,
      renderer: "figma-local-context-mcp",
      source: "decoded-local-fig"
    },
    localPng: {
      supported: true,
      renderer: "@resvg/resvg-js",
      source: "mcp-generated-svg",
      fidelity: "preview"
    },
    figmaLikePng: {
      supported: true,
      renderer: "@resvg/resvg-js",
      source: "mcp-generated-svg-with-figma-like-filter-compensation",
      fidelity: "approximate"
    },
    figmaNativePng: {
      supported: false,
      reason:
        "Figma native PNG export uses Figma's own renderer. This MCP implements a local figma-like approximation instead of calling Figma."
    }
  }
}

function defaultOutputPath(options: ExportNodeOptions): string {
  const input = path.parse(options.filePath)
  const nodePart = sanitizeFilePart(options.nodeQuery)
  const scalePart = options.format === "png" ? `@${options.scale}x` : ""
  return path.join(process.cwd(), `${input.name}-${nodePart}${scalePart}.${options.format}`)
}

function applyFigmaLikeRasterHints(
  pixels: Buffer,
  width: number,
  height: number,
  viewBox: { minX: number; minY: number; maxX: number; maxY: number },
  hints: FigmaLikeRasterHint[]
) {
  const sx = width / (viewBox.maxX - viewBox.minX)
  const sy = height / (viewBox.maxY - viewBox.minY)

  for (const hint of hints) {
    if (hint.type !== "ellipse-inner-shadow") continue

    const inverse = invertMatrix(hint.matrix)
    const color = {
      r: toByte(hint.color.r),
      g: toByte(hint.color.g),
      b: toByte(hint.color.b)
    }
    const masks = createEllipseInnerShadowMasks(width, height, viewBox, sx, sy, hint, inverse)
    const blurScale = (Math.abs(sx) + Math.abs(sy)) / 2
    const blurredErodedMask = gaussianBlurMask(masks.erodedMask, width, height, Math.max(0.5, hint.blurSigma * blurScale))

    for (let index = 0; index < masks.hardMask.length; index += 1) {
      if (masks.hardMask[index] === 0) continue

      const shadowCoverage = Math.max(0, masks.hardMask[index] - blurredErodedMask[index])
      const shadowAlpha = Math.min(1, shadowCoverage * hint.opacity)
      if (shadowAlpha <= 0.001) continue

      compositePixel(pixels, index * 4, color.r, color.g, color.b, shadowAlpha)
    }
  }
}

function createEllipseInnerShadowMasks(
  width: number,
  height: number,
  viewBox: { minX: number; minY: number; maxX: number; maxY: number },
  sx: number,
  sy: number,
  hint: FigmaLikeRasterHint,
  inverse: readonly [number, number, number, number, number, number]
) {
  const hardMask = new Float32Array(width * height)
  const erodedMask = new Float32Array(width * height)
  const erodedRx = Math.max(0.1, hint.rx - hint.spread)
  const erodedRy = Math.max(0.1, hint.ry - hint.spread)
  const sampleWeight = 1 / (MASK_SUPERSAMPLE * MASK_SUPERSAMPLE)

  // Figma's native PNG export appears to build inner shadow coverage from a
  // vector mask, then erode and blur that mask. Subpixel coverage is important:
  // a hard pixel-center mask makes shallow ellipse edges visibly stair-step.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      let hardCoverage = 0
      let erodedCoverage = 0

      for (let sampleY = 0; sampleY < MASK_SUPERSAMPLE; sampleY += 1) {
        const worldY = viewBox.minY + (y + (sampleY + 0.5) / MASK_SUPERSAMPLE) / sy
        for (let sampleX = 0; sampleX < MASK_SUPERSAMPLE; sampleX += 1) {
          const worldX = viewBox.minX + (x + (sampleX + 0.5) / MASK_SUPERSAMPLE) / sx
          const local = applyMatrix(inverse, worldX, worldY)
          const normalizedX = (local.x - hint.cx) / hint.rx
          const normalizedY = (local.y - hint.cy) / hint.ry
          if (normalizedX * normalizedX + normalizedY * normalizedY > 1) continue

          hardCoverage += sampleWeight

          const erodedX = (local.x - hint.cx) / erodedRx
          const erodedY = (local.y - hint.cy) / erodedRy
          if (erodedX * erodedX + erodedY * erodedY <= 1) {
            erodedCoverage += sampleWeight
          }
        }
      }

      hardMask[index] = hardCoverage
      erodedMask[index] = erodedCoverage
    }
  }

  return { hardMask, erodedMask }
}

function gaussianBlurMask(mask: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0.01) return mask

  const kernel = createGaussianKernel(sigma)
  const radius = (kernel.length - 1) / 2
  const temp = new Float32Array(mask.length)
  const output = new Float32Array(mask.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offset))
        value += mask[y * width + sampleX] * kernel[offset + radius]
      }
      temp[y * width + x] = value
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offset))
        value += temp[sampleY * width + x] * kernel[offset + radius]
      }
      output[y * width + x] = value
    }
  }

  return output
}

function createGaussianKernel(sigma: number): number[] {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel: number[] = []
  let sum = 0

  for (let offset = -radius; offset <= radius; offset += 1) {
    const value = Math.exp(-(offset * offset) / (2 * sigma * sigma))
    kernel.push(value)
    sum += value
  }

  return kernel.map((value) => value / sum)
}

function unpremultiplyPixels(pixels: Buffer) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]
    if (alpha === 0 || alpha === 255) continue

    pixels[offset] = Math.min(255, Math.round((pixels[offset] * 255) / alpha))
    pixels[offset + 1] = Math.min(255, Math.round((pixels[offset + 1] * 255) / alpha))
    pixels[offset + 2] = Math.min(255, Math.round((pixels[offset + 2] * 255) / alpha))
  }
}

function compositePixel(pixels: Buffer, offset: number, sourceR: number, sourceG: number, sourceB: number, sourceA: number) {
  const destA = pixels[offset + 3] / 255
  const outA = sourceA + destA * (1 - sourceA)
  if (outA <= 0) return

  pixels[offset] = Math.round((sourceR * sourceA + pixels[offset] * destA * (1 - sourceA)) / outA)
  pixels[offset + 1] = Math.round((sourceG * sourceA + pixels[offset + 1] * destA * (1 - sourceA)) / outA)
  pixels[offset + 2] = Math.round((sourceB * sourceA + pixels[offset + 2] * destA * (1 - sourceA)) / outA)
  pixels[offset + 3] = Math.round(outA * 255)
}

function encodeRgbaPng(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1)
    raw[rowOffset] = 0
    pixels.copy(raw, rowOffset + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", createIhdr(width, height)),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ])
}

function createIhdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = 8
  data[9] = 6
  data[10] = 0
  data[11] = 0
  data[12] = 0
  return data
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function invertMatrix(matrix: [number, number, number, number, number, number]) {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (Math.abs(determinant) < Number.EPSILON) return [1, 0, 0, 1, 0, 0] as const

  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant
  ] as const
}

function applyMatrix(matrix: readonly [number, number, number, number, number, number], x: number, y: number) {
  const [a, b, c, d, e, f] = matrix
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

function toByte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
}
