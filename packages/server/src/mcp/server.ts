import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import type { ContentBlock, Tool, Transport } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import type { McpRuntime } from "../mcp-runtime"
import { Effect, Option, Schema } from "effect"
import { McpOAuth } from "./oauth"

const decodeMethod = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ method: Schema.String })))
const decodeAgent = Schema.decodeUnknownSync(Schema.Struct({ agent: Schema.String }))
const contextURI = "opencode://session/context"
const additional: Tool[] = [
  {
    name: "opencode_context",
    description:
      "Get the current OpenCode agent prompt, repository/global instructions, available agents and skill catalog. Call this before working, and again after selecting another agent. Load skills with the native skill tool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "opencode_agent",
    description:
      "Select an OpenCode agent for this external session. Its permissions, prompt and tool visibility apply to subsequent calls. This does not run an LLM.",
    inputSchema: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
  },
  {
    name: "opencode_updates",
    description:
      "Read user input, nested repository instructions and background task completions from the OpenCode session. No internal model is started. Messages have stable IDs for deduplication.",
    inputSchema: { type: "object", properties: {} },
  },
]

export namespace McpServer {
  export async function serve(runtime: McpRuntime.Tools, suppliedTransport?: Transport, authenticated = false) {
    const server = new Server(
      { name: "opencode", version: runtime.version },
      {
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: {} },
        instructions:
          "Call opencode_context before working. These are the real OpenCode tools and policies. Questions and permission requests wait for the user in the OpenCode TUI/GUI attached to this server. Use opencode_updates for background results and user input. Do not retry a pending mutating call; it may be awaiting approval.",
      },
    )
    const seen = new Set<string>()
    const initialized = { value: false }
    server.oninitialized = () => {
      initialized.value = true
    }
    const updates = async () => {
      const messages = (await runtime.updates()).filter((message) => !seen.has(message.id))
      messages.forEach((message) => seen.add(message.id))
      return messages
    }
    server.setRequestHandler("tools/list", async () => {
      const native = await runtime.catalog()
      if (native.some((tool) => additional.some((entry) => entry.name === tool.name)))
        throw new Error("An OpenCode tool conflicts with the reserved MCP context tool names")
      const tools: Tool[] = [
        ...native.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { ...tool.inputSchema, type: "object" as const },
          // MCP structuredContent is object-only, unlike OpenCode outputs. Return canonical model content.
        })),
        ...additional,
      ]
      return {
        tools: authenticated
          ? tools.map((tool) => ({
              ...tool,
              securitySchemes: [{ type: "oauth2", scopes: ["opencode:tools"] }],
              _meta: { securitySchemes: [{ type: "oauth2", scopes: ["opencode:tools"] }] },
            }))
          : tools,
      }
    })
    server.setRequestHandler("tools/call", async ({ params }, extra) => {
      try {
        if (params.name === "opencode_context") return text(JSON.stringify(await runtime.context()))
        if (params.name === "opencode_updates") return text(JSON.stringify(await updates()))
        if (params.name === "opencode_agent") {
          await runtime.switchAgent(decodeAgent(params.arguments).agent)
          await server.sendToolListChanged()
          return text(JSON.stringify(await runtime.context()))
        }
        const result = await runtime.execute(params.name, params.arguments ?? {}, { signal: extra.mcpReq.signal })
        const messages = await updates()
        return {
          content: [
            ...result.content.map(toContent),
            ...(messages.length
              ? [{ type: "text" as const, text: `OpenCode context updates:\n${JSON.stringify(messages)}` }]
              : []),
          ],
          _meta: { sessionID: runtime.sessionID, ...result.metadata },
        }
      } catch (cause) {
        return { ...text(cause instanceof Error ? cause.message : String(cause)), isError: true }
      }
    })
    server.setRequestHandler("resources/list", async () => ({
      resources: [{ uri: contextURI, name: "OpenCode session context", mimeType: "application/json" }],
    }))
    server.setRequestHandler("resources/read", async ({ params }) => {
      if (params.uri !== contextURI) throw new Error(`Unknown resource: ${params.uri}`)
      return {
        contents: [{ uri: contextURI, mimeType: "application/json", text: JSON.stringify(await runtime.context()) }],
      }
    })
    server.setRequestHandler("prompts/list", async () => ({
      prompts: [
        { name: "opencode", description: "Current OpenCode system prompt and repository context" },
        ...(await runtime.context()).agents.map((agent) => ({
          name: `agent:${agent.id}`,
          description: agent.description ?? agent.id,
        })),
      ],
    }))
    server.setRequestHandler("prompts/get", async ({ params }) => {
      const context = await runtime.context()
      if (params.name === "opencode")
        return {
          messages: [{ role: "user", content: { type: "text", text: `${context.system}\n\n${context.instructions}` } }],
        }
      const agent = context.agents.find((agent) => params.name === `agent:${agent.id}`)
      if (!agent) throw new Error(`Unknown prompt: ${params.name}`)
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                agent.system ||
                `Use opencode_agent with agent=${agent.id}, then read opencode_context for the resolved default prompt.`,
            },
          },
        ],
      }
    })
    const transport = suppliedTransport ?? new StdioServerTransport()
    await server.connect(transport)
    const stop = await runtime.watch(() => (initialized.value ? server.sendToolListChanged() : Promise.resolve()))
    server.onclose = () => {
      void stop()
    }
    if (!suppliedTransport) {
      const end = () => {
        void server.close()
      }
      process.stdin.once("end", end)
      server.onclose = () => {
        process.stdin.off("end", end)
        void stop()
      }
    }
    return server
  }

  export function stdio(runtime: McpRuntime.Tools) {
    return Effect.acquireRelease(
      Effect.promise(() => serve(runtime)),
      (server) => Effect.promise(() => server.close()),
    ).pipe(
      Effect.flatMap((server) =>
        Effect.callback<void>((resume) => {
          const onclose = server.onclose
          server.onclose = () => {
            onclose?.()
            resume(Effect.void)
          }
        }),
      ),
    )
  }

  export function listen(
    runtime: McpRuntime.Tools,
    options: {
      hostname: string
      port: number
      oauth?: McpOAuth.Options
      onRequest?: (event: {
        method: string
        path: string
        rpc?: string
        status: number
        authorization: boolean
      }) => void
    },
  ) {
    const oauth = options.oauth ? McpOAuth.make(options.oauth) : undefined
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
    const handle = async (request: Request) => {
      const response = await oauth?.handle(request)
      if (response) return response
      if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 })
      const unauthorized = oauth?.authorize(request)
      if (unauthorized) return unauthorized
      const session = request.headers.get("mcp-session-id")
      if (session) {
        const current = sessions.get(session)
        return current ? current.handleRequest(request) : new Response("Unknown MCP session", { status: 404 })
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
      await serve(runtime, transport, Boolean(oauth))
      const onclose = transport.onclose
      transport.onclose = () => {
        onclose?.()
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      const result = await transport.handleRequest(request)
      if (transport.sessionId) sessions.set(transport.sessionId, transport)
      return result
    }
    const http = Bun.serve({
      hostname: options.hostname,
      port: options.port,
      idleTimeout: 0,
      maxRequestBodySize: 1024 * 1024,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname
        const rpc =
          options.onRequest && request.method === "POST" && pathname === "/mcp"
            ? Option.getOrUndefined(decodeMethod(await request.clone().text()))?.method
            : undefined
        const response = await handle(request)
        options.onRequest?.({
          method: request.method,
          path: pathname,
          rpc,
          status: response.status,
          authorization: request.headers.has("authorization"),
        })
        return response
      },
    })
    return {
      url: `http://${options.hostname}:${http.port}/mcp`,
      close: () => {
        sessions.forEach((transport) => void transport.close())
        return http.stop(true)
      },
    }
  }
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}

function toContent(item: Awaited<ReturnType<McpRuntime.Tools["execute"]>>["content"][number]): ContentBlock {
  if (item.type === "text") return item
  const data = /^data:[^,]*;base64,(.*)$/s.exec(item.uri)?.[1]
  if (data !== undefined && item.mime.startsWith("image/")) return { type: "image", data, mimeType: item.mime }
  if (data !== undefined) return { type: "resource", resource: { uri: item.uri, mimeType: item.mime, blob: data } }
  return { type: "resource_link", uri: item.uri, name: item.name ?? item.uri, mimeType: item.mime }
}
