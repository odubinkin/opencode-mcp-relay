import { Schema } from "effect"

const Command = Schema.Struct({
  request_id: Schema.String,
  shard_token: Schema.String,
  command_type: Schema.String,
  channel: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  jsonrpc: Schema.optionalKey(Schema.Unknown),
  response_timeout: Schema.optionalKey(Schema.Unknown),
})
const Poll = Schema.Struct({ commands: Schema.Array(Command) })
const decodePoll = Schema.decodeUnknownSync(Poll)

const responseHeaders = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "access-control-expose-headers",
  "www-authenticate",
]
const requestHeaders = ["mcp-session-id", "mcp-protocol-version", "last-event-id", "accept", "content-type"]
const timeoutUnits: Record<string, number> = {
  ns: 0.000001,
  us: 0.001,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

export namespace OpenAiTunnel {
  export type Options = {
    tunnelID: string
    apiKey: string
    localURL: string
    // The injectable control plane is for tests; production always uses OpenAI's HTTPS API.
    baseURL?: string
  }

  export function validate(tunnelID: string) {
    if (!/^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(tunnelID))
      throw new Error("Invalid OpenAI tunnel ID")
  }

  export async function connect(options: Options) {
    validate(options.tunnelID)
    const controller = new AbortController()
    const instance = crypto.randomUUID()
    const base = `${options.baseURL ?? "https://api.openai.com"}/v1/tunnels/${options.tunnelID}`
    const headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "X-Tunnel-Client-Name": "opencode",
      "X-Tunnel-Client-Version": "1",
      "X-Tunnel-Client-Instance-Id": instance,
      "X-Tunnel-Client-Wire-Protocol-Version": "2026-08-25",
      "X-Tunnel-MCP-Server-Info": JSON.stringify({ version: 1, channels: [{ name: "main", proc_affinity: true }] }),
    }

    const control = (endpoint: string, init: RequestInit = {}) =>
      fetch(`${base}${endpoint}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: init.signal ?? controller.signal,
      })

    // Fail the start operation immediately for invalid credentials or a missing tunnel.
    const metadata = await control("")
    if (!metadata.ok) throw new Error(`OpenAI tunnel authentication failed (HTTP ${metadata.status})`)
    await metadata.body?.cancel()

    const pending = new Set<Promise<void>>()
    const pause = (duration: number) =>
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) return resolve()
        const finish = () => {
          clearTimeout(timer)
          controller.signal.removeEventListener("abort", finish)
          resolve()
        }
        const timer = setTimeout(finish, duration)
        controller.signal.addEventListener("abort", finish, { once: true })
      })
    const post = async (
      command: typeof Command.Type,
      data: { resp_code: number; resp_type: string; resp_json?: unknown; resp_headers?: Record<string, string[]> },
      signal: AbortSignal,
    ) => {
      if (signal.aborted) return
      const response = await control("/response", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tunnel-Shard-Token": command.shard_token },
        body: JSON.stringify({
          request_id: command.request_id,
          channel: command.channel ?? "main",
          ...data,
        }),
        signal,
      })
      if (!response.ok) throw new Error(`OpenAI tunnel response rejected (HTTP ${response.status})`)
      await response.body?.cancel()
    }

    const forward = async (command: typeof Command.Type, received: number) => {
      if (command.channel && command.channel !== "main") return
      if (command.command_type !== "jsonrpc" && command.command_type !== "session_termination") return
      const timeout = typeof command.response_timeout === "string" && /^(\d+)(ns|us|ms|s|m|h)$/.exec(command.response_timeout)
      const duration = timeout ? Number(timeout[1]) * timeoutUnits[timeout[2]!]! : undefined
      const deadline = duration !== undefined && Number.isFinite(duration) ? received + duration : undefined
      const remaining = deadline === undefined ? undefined : deadline - performance.now()
      if (remaining !== undefined && remaining <= 0) return
      const signal = remaining === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, AbortSignal.timeout(Math.ceil(remaining))])
      const upstream = new Headers()
      for (const [key, values] of Object.entries(command.headers ?? {})) {
        if (requestHeaders.includes(key.toLowerCase()) && values.length) upstream.set(key, values.join(", "))
      }
      const session = upstream.get("mcp-session-id")
      if (command.command_type === "session_termination" && !session) return
      const notify = command.command_type === "jsonrpc" && command.jsonrpc !== null
        && typeof command.jsonrpc === "object" && !Array.isArray(command.jsonrpc)
        && !("id" in command.jsonrpc)

      try {
        const result = await fetch(options.localURL, {
          method: command.command_type === "session_termination" ? "DELETE" : "POST",
          headers: command.command_type === "jsonrpc"
            ? new Headers({ ...Object.fromEntries(upstream), "Content-Type": "application/json", Accept: "application/json, text/event-stream" })
            : upstream,
          body: command.command_type === "jsonrpc" ? JSON.stringify(command.jsonrpc) : undefined,
          signal,
        })
        const allowed = Object.fromEntries(
          responseHeaders.flatMap((name) => {
            const value = result.headers.get(name)
            return value ? [[name, [value]]] : []
          }),
        )
        if (command.command_type === "session_termination") {
          await result.body?.cancel()
          await post(command, { resp_code: result.status === 404 ? 204 : result.status, resp_type: "session_termination_response" }, signal)
          return
        }
        if (notify || result.status === 202) {
          await result.body?.cancel()
          await post(command, { resp_code: result.status, resp_type: "notify_ack", resp_headers: allowed }, signal)
          return
        }
        if (result.headers.get("content-type")?.includes("text/event-stream")) {
          const reader = result.body?.getReader()
          if (!reader) throw new Error("MCP event stream is empty")
          const decoder = new TextDecoder()
          let buffered = ""
          let final = false
          for (;;) {
            const chunk = await reader.read()
            buffered += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
            const frames = buffered.split(/\r?\n\r?\n/)
            buffered = frames.pop() ?? ""
            for (const frame of frames) {
              const payload = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
              if (!payload) continue
              const json = JSON.parse(payload) as unknown
              const terminal = json !== null && typeof json === "object" && !Array.isArray(json) && "id" in json
              await post(command, {
                resp_code: result.status,
                resp_type: terminal ? "jsonrpc_response" : "jsonrpc_notify",
                resp_json: json,
                resp_headers: allowed,
              }, signal)
              if (terminal) final = true
            }
            if (chunk.done || final) break
          }
          await reader.cancel().catch(() => undefined)
          if (!final) throw new Error("MCP event stream ended without a response")
          return
        }
        const text = await result.text()
        const json = text ? JSON.parse(text) as unknown : undefined
        if (json === undefined) throw new Error("MCP returned an empty response")
        await post(command, {
          resp_code: result.status,
          resp_type: "jsonrpc_response",
          resp_json: json,
          resp_headers: allowed,
        }, signal)
      } catch (error) {
        if (signal.aborted) return
        if (notify || command.command_type === "session_termination") {
          await post(command, {
            resp_code: 502,
            resp_type: command.command_type === "session_termination" ? "session_termination_response" : "notify_ack",
          }, signal).catch(() => undefined)
          return
        }
        const id = command.jsonrpc !== null && typeof command.jsonrpc === "object"
          && !Array.isArray(command.jsonrpc) && "id" in command.jsonrpc ? command.jsonrpc.id : null
        await post(command, {
          resp_code: 502,
          resp_type: "jsonrpc_response",
          resp_json: {
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: "Local MCP transport failed" },
          },
          resp_headers: { "content-type": ["application/json"] },
        }, signal).catch(() => undefined)
      }
    }

    const loop = async () => {
      let delay = 1_000
      while (!controller.signal.aborted) {
        try {
          const response = await control("/poll?limit=8&timeout_ms=15000")
          const received = performance.now()
          if (!response.ok && response.status !== 204)
            throw new Error(`OpenAI tunnel poll failed (HTTP ${response.status})`)
          if (response.status === 204) {
            delay = 1_000
            continue
          }
          const data = decodePoll(await response.json())
          delay = 1_000
          for (const command of data.commands) {
            if (controller.signal.aborted) break
            if (pending.size >= 8) await Promise.race(pending)
            const task = forward(command, received)
              .catch(() => undefined)
              .finally(() => pending.delete(task))
            pending.add(task)
          }
        } catch {
          if (controller.signal.aborted) return
          await pause(delay)
          delay = Math.min(delay * 2, 20_000)
        }
      }
    }
    const running = loop()
    return {
      close: async () => {
        controller.abort()
        await running
        await Promise.allSettled(pending)
      },
    }
  }
}
