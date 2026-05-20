import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createServer } from "./mcp/index.js"

export async function startStdioServer(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.on("SIGINT", async () => {
    await server.close()
    process.exit(0)
  })
  process.on("SIGTERM", async () => {
    await server.close()
    process.exit(0)
  })
}
