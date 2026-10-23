import { expect, test } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import { McpRuntime } from "@opencode/server/mcp-runtime"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Schema } from "effect"
import path from "node:path"
import { it } from "../../core/test/lib/effect"
import { McpServer } from "../src/mcp/server"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

it.live("serves native tools, context, prompts and skills through HTTP MCP", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
    yield* Effect.promise(() =>
      Bun.write(path.join(directory.path, "AGENTS.md"), "Repository instruction: mcp-native-context"),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory.path, ".opencode/skills/example/SKILL.md"),
        "---\nname: example\ndescription: An example skill\n---\nSkill instruction: mcp-native-skill\n",
      ),
    )
    const upstream = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } })
        server.setRequestHandler("tools/list", async () => ({
          tools: [
            {
              name: "echo",
              description: "Upstream echo",
              inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            },
          ],
        }))
        server.setRequestHandler("tools/call", async ({ params }) => ({
          content: [{ type: "text", text: `upstream:${JSON.stringify(params.arguments)}` }],
        }))
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        })
        await server.connect(transport)
        const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => transport.handleRequest(request) })
        return { server, http }
      }),
      (upstream) =>
        Effect.promise(async () => {
          await upstream.server.close()
          await upstream.http.stop(true)
        }),
    )
    const runtime = yield* McpRuntime.make({
      directory: directory.path,
      server: {
        database: { path: ":memory:" },
        config: {
          directory: path.join(directory.path, "config"),
          content: JSON.stringify({
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
            mcp: {
              servers: {
                upstream: { type: "remote", url: `http://127.0.0.1:${upstream.http.port}/mcp`, oauth: false },
              },
            },
          }),
        },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
    })
    yield* Effect.promise(async () => {
      const server = McpServer.listen(runtime, { hostname: "127.0.0.1", port: 0 })
      const client = new Client({ name: "opencode-test", version: "1.0.0" })
      const connected = Promise.withResolvers<void>()
      client.setNotificationHandler("notifications/tools/list_changed", async () => {
        if ((await client.listTools()).tools.some((tool) => tool.name === "upstream_echo")) connected.resolve()
      })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const initial = (await client.listTools()).tools.map((tool) => tool.name)
        if (!initial.includes("upstream_echo")) await connected.promise
        const names = (await client.listTools()).tools.map((tool) => tool.name)
        expect(names).toEqual(
          expect.arrayContaining([
            "read",
            "write",
            "edit",
            "shell",
            "skill",
            "question",
            "opencode_context",
            "opencode_updates",
            "opencode_session_rename",
            "upstream_echo",
          ]),
        )
        expect(names).not.toContain("execute")
        expect(names).not.toContain("subagent")
        expect(
          await client.callTool({
            name: "upstream_echo",
            arguments: { value: "native-upstream", _opencode_summary: "Echo through the upstream server" },
          }),
        ).toMatchObject({ content: [{ text: `upstream:${JSON.stringify({ value: "native-upstream" })}` }] })
        expect((await client.callTool({ name: "subagent", arguments: {} })).isError).toBe(true)
        expect(await client.callTool({ name: "opencode_context" })).toMatchObject({
          content: [{ text: expect.stringContaining("mcp-native-context") }],
        })
        expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain("opencode")
        expect(await client.readResource({ uri: "opencode://session/context" })).toMatchObject({
          contents: [{ text: expect.stringContaining("mcp-native-context") }],
        })
        const target = path.join(directory.path, "example.txt")
        expect(
          (
            await client.callTool({
              name: "write",
              arguments: { path: target, content: "first\nsecond\n", _opencode_summary: "Create the example file" },
            })
          ).isError,
        ).not.toBe(true)
        await client.callTool({ name: "read", arguments: { path: target, _opencode_summary: "Read the example file" } })
        expect(
          (
            await client.callTool({
              name: "edit",
              arguments: {
                path: target,
                oldString: "second",
                newString: "updated",
                _opencode_summary: "Update the second line",
              },
            })
          ).isError,
        ).not.toBe(true)
        expect(await Bun.file(target).text()).toBe("first\nupdated\n")
        expect(
          await client.callTool({
            name: "shell",
            arguments: { command: "echo command-ok", _opencode_summary: "Check shell execution" },
          }),
        ).toMatchObject({ content: [{ text: expect.stringContaining("command-ok") }] })
        const context = await runtime.context()
        const skill = context.skills.find((skill) => skill.name === "example")
        expect(skill).toBeDefined()
        if (!skill) throw new Error("Skill not discovered")
        expect(
          await client.callTool({
            name: "skill",
            arguments: { id: skill.id, _opencode_summary: "Load repository guidance" },
          }),
        ).toMatchObject({
          content: [{ text: expect.stringContaining("mcp-native-skill") }],
        })
        const nativeSession = await runtime.fetch(new Request(`http://local/api/session/${runtime.sessionID}`))
        expect(await nativeSession.json()).toMatchObject({ data: { driver: "external" } })
        const history = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Array(Schema.toEncoded(SessionMessage.Info)) }),
        )(
          await (
            await runtime.fetch(new Request(`http://local/api/session/${runtime.sessionID}/message?limit=200`))
          ).json(),
        )
        const tools = history.data.flatMap((message) => (message.type === "tool" ? [message.tool] : []))
        expect(tools.find((tool) => tool.name === "write")).toMatchObject({
          state: { status: "completed", input: { path: target } },
        })
        expect(tools.find((tool) => tool.name === "read")).toMatchObject({
          state: { status: "completed", input: { path: target } },
        })
        expect(tools.find((tool) => tool.name === "edit")).toMatchObject({
          state: {
            status: "completed",
            metadata: {
              files: [{ file: "example.txt", additions: 1, deletions: 1, patch: expect.stringContaining("+updated") }],
            },
          },
        })
        expect(tools.find((tool) => tool.name === "shell")).toMatchObject({
          state: {
            status: "completed",
            input: { command: "echo command-ok" },
            content: [{ text: expect.stringContaining("command-ok") }],
            metadata: { exit: 0 },
          },
        })
        expect(JSON.stringify(history)).not.toContain('"type":"assistant"')
        // An HTTP transport reconnect preserves the external Session, independent of MCP session IDs.
        await client.close()
        const another = new Client({ name: "reconnect", version: "1" })
        await another.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        expect(await another.callTool({ name: "opencode_context" })).toMatchObject({
          content: [{ text: expect.stringContaining(runtime.sessionID) }],
        })
        await another.close()
      } finally {
        await client.close()
        await server.close()
      }
    })
  }),
)

test("serves the native registry over stdio without logging into stdout", async () => {
  await using directory = await tmpdir()
  const client = new Client({ name: "stdio-test", version: "1" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/mcp/standalone.ts", "--transport", "stdio", "--directory", directory.path],
    cwd: path.join(import.meta.dir, ".."),
    env: Object.fromEntries(
      Object.entries(
        isolatedEnv(directory.path, {
          OPENCODE_MCP_UI_PORT: "0",
          OPENCODE_MCP_STATE_DIRECTORY: path.join(directory.path, "runtime"),
        }),
      ).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stderr: "pipe",
  })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("read")
  } finally {
    await client.close()
  }
})
