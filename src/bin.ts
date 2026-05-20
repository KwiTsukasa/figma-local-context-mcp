#!/usr/bin/env node

import { cli } from "cleye"
import { startStdioServer } from "./server.js"

const argv = cli({
  name: "figma-local-context-mcp",
  version: process.env.NPM_PACKAGE_VERSION ?? "0.1.0",
  flags: {
    stdio: {
      type: Boolean,
      description: "Run in stdio transport mode for MCP clients"
    }
  }
})

async function main(): Promise<void> {
  if (!argv.flags.stdio) {
    process.stderr.write("当前版本只支持 stdio，请传入 --stdio。\n")
  }
  await startStdioServer()
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`启动失败：${message}\n`)
  process.exit(1)
})
