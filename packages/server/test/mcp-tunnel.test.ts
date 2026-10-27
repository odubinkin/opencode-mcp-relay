import { expect, test } from "bun:test"
import { OpenAiTunnel } from "../src/mcp/tunnel"

const tunnelID = "tunnel_0123456789abcdef0123456789abcdef"

test("OpenAI tunnel forwards JSON-RPC, SSE, notifications, and session termination without exposing an MCP port", async () => {
  const localCalls: { method: string; body?: { method?: string }; session?: string; protocol?: string; authorization?: string }[] = []
  const mcp = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = request.method === "POST" ? await request.json() as { method?: string; id?: number } : undefined
      localCalls.push({
        method: request.method,
        body,
        session: request.headers.get("mcp-session-id") ?? undefined,
        protocol: request.headers.get("mcp-protocol-version") ?? undefined,
        authorization: request.headers.get("authorization") ?? undefined,
      })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body?.method === "tools/list")
        return new Response(
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        )
      return Response.json({ jsonrpc: "2.0", id: body?.id, result: { ok: true } }, {
        headers: { "Mcp-Session-Id": "local-session" },
      })
    },
  })
  const commands = [
    { request_id: "r1", shard_token: "shard1", command_type: "jsonrpc", headers: { "Mcp-Protocol-Version": ["2025-03-26"] }, jsonrpc: { jsonrpc: "2.0", id: 1, method: "initialize" } },
    { request_id: "r2", shard_token: "shard2", command_type: "jsonrpc", jsonrpc: { jsonrpc: "2.0", id: 2, method: "tools/list" } },
    { request_id: "r3", shard_token: "shard3", command_type: "jsonrpc", jsonrpc: { jsonrpc: "2.0", method: "notifications/initialized" } },
    { request_id: "r4", shard_token: "shard4", command_type: "session_termination", headers: { "Mcp-Session-Id": ["local-session"] } },
    { request_id: "expired", shard_token: "shard5", command_type: "jsonrpc", response_timeout: "0s", jsonrpc: { jsonrpc: "2.0", id: 3, method: "tools/call" } },
  ]
  const posts: { shard: string; body: { request_id: string; resp_code: number; resp_type: string; resp_json?: { id?: number }; resp_headers?: Record<string, string[]> } }[] = []
  let polled = false
  const done = Promise.withResolvers<void>()
  const control = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer secret-key")
      expect(request.headers.get("x-tunnel-mcp-server-info")).toContain('"main"')
      const url = new URL(request.url)
      if (url.pathname.endsWith("/poll")) {
        if (!polled) {
          polled = true
          return Response.json({ commands })
        }
        await Bun.sleep(20)
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith("/response")) {
        posts.push({
          shard: request.headers.get("x-tunnel-shard-token") ?? "",
          body: await request.json() as typeof posts[number]["body"],
        })
        if (posts.length === 5) done.resolve()
        return new Response(null, { status: 204 })
      }
      return Response.json({ id: tunnelID })
    },
  })
  let client: Awaited<ReturnType<typeof OpenAiTunnel.connect>> | undefined
  try {
    client = await OpenAiTunnel.connect({
      tunnelID,
      apiKey: "secret-key",
      localURL: new URL("/mcp", mcp.url).toString(),
      baseURL: new URL(control.url).origin,
    })
    await Promise.race([done.promise, Bun.sleep(4_000).then(() => { throw new Error("Tunnel did not return all MCP responses") })])
    expect(posts.map((post) => post.body.request_id).sort()).toEqual(["r1", "r2", "r2", "r3", "r4"])
    expect(posts.find((post) => post.body.request_id === "r1")).toMatchObject({
      shard: "shard1",
      body: { resp_code: 200, resp_type: "jsonrpc_response", resp_json: { id: 1 }, resp_headers: { "mcp-session-id": ["local-session"] } },
    })
    expect(posts.filter((post) => post.body.request_id === "r2").map((post) => post.body.resp_type).sort()).toEqual(["jsonrpc_notify", "jsonrpc_response"])
    expect(posts.find((post) => post.body.request_id === "r3")?.body.resp_type).toBe("notify_ack")
    expect(posts.find((post) => post.body.request_id === "r4")?.body).toMatchObject({ resp_code: 204, resp_type: "session_termination_response" })
    expect(localCalls).toHaveLength(4)
    expect(localCalls.find((call) => call.body?.method === "initialize")?.protocol).toBe("2025-03-26")
    expect(localCalls.find((call) => call.method === "DELETE")?.session).toBe("local-session")
    expect(localCalls.every((call) => call.authorization === undefined)).toBe(true)
  } finally {
    await client?.close()
    await control.stop()
    await mcp.stop()
  }
}, 10_000)

test("OpenAI tunnel rejects invalid IDs and invalid API credentials at startup", async () => {
  expect(() => OpenAiTunnel.validate("https://localhost")).toThrow("Invalid OpenAI tunnel ID")
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("Unauthorized", { status: 401 }),
  })
  try {
    await expect(OpenAiTunnel.connect({
      tunnelID,
      apiKey: "invalid-key",
      localURL: "http://127.0.0.1:1234/mcp",
      baseURL: new URL(control.url).origin,
    })).rejects.toThrow("HTTP 401")
  } finally {
    await control.stop()
  }
})
