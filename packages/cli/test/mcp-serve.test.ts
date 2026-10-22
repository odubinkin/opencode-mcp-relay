import { expect, test } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import path from "node:path"
import { McpServer } from "../src/mcp/server"
import { tmpdir } from "./fixture/tmpdir"

test("serves filesystem and shell tools over MCP", async () => {
  await using directory = await tmpdir()
  const client = new Client({ name: "opencode-test", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/index.ts", "mcp", "serve", directory.path],
    cwd: path.join(import.meta.dir, ".."),
  })
  await client.connect(transport)
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "list_directory",
    "read_file",
    "write_file",
    "edit_file",
    "run_command",
  ])
  await client.callTool({ name: "write_file", arguments: { path: "nested/example.txt", content: "first\nsecond\n" } })
  await client.callTool({
    name: "edit_file",
    arguments: { path: "nested/example.txt", old_string: "second", new_string: "updated" },
  })
  expect(await client.callTool({ name: "read_file", arguments: { path: "nested/example.txt" } })).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining("2: updated") }],
  })
  expect(await client.callTool({ name: "list_directory", arguments: { path: "nested" } })).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining("example.txt") }],
  })
  expect(await client.callTool({ name: "run_command", arguments: { command: "echo command-ok" } })).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining("command-ok") }],
  })
  await client.close()
})

test("serves filesystem tools over HTTP", async () => {
  await using directory = await tmpdir()
  const server = McpServer.listen(directory.path, { hostname: "127.0.0.1", port: 0 })
  const client = new Client({ name: "opencode-test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  await client.callTool({ name: "write_file", arguments: { path: "example.txt", content: "hello" } })
  expect(await client.callTool({ name: "read_file", arguments: { path: "example.txt" } })).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining("1: hello") }],
  })
  await client.close()
  server.close()
})
