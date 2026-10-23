import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { ConfigMcpRelay, McpRelayStatus } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("configures Relay through connect and opens its external session without a model", async () => {
  const requests: { path: string; method: string; body?: unknown }[] = []
  const status: { value: McpRelayStatus } = { value: { running: false } }
  const session = {
    id: "ses_relay_ui",
    title: "MCP Relay",
    projectID: "project",
    driver: "external",
    agent: "build",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  await using setup = await createAppFixture({
    width: 100,
    height: 40,
    config: { animations: false, keybinds: { "provider.connect": "f8", "mcp.relay.mode": "f9" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/mcp/relay" && request.method === "GET") return json(status.value)
      if (url.pathname === "/api/mcp/relay" && request.method === "PUT") {
        const body: { settings: ConfigMcpRelay } = await request.json()
        requests.push({ path: url.pathname, method: request.method, body })
        status.value = { running: false, settings: body.settings }
        return json(status.value)
      }
      if (url.pathname === "/api/mcp/relay/start") {
        requests.push({ path: url.pathname, method: request.method })
        status.value = {
          ...status.value,
          running: true,
          directory,
          sessionID: session.id,
          url: "https://relay.example/mcp",
        }
        return json(status.value)
      }
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/prompt`) {
        const body = await request.json()
        requests.push({ path: url.pathname, method: request.method, body })
        return json({
          data: {
            id: body.id,
            sessionID: session.id,
            type: "user",
            payload: { text: body.text },
            delivery: "steer",
            time: { created: 1 },
          },
        })
      }
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame(
    (frame) => frame.includes("Build") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame(
    (frame) => frame.includes("MCP Relay Mode") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("MCP Relay Mode")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Stopped") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Public URL")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes("origin without /mcp") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("https://relay.example")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Callback URLs") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Callback URLs")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("one per line") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("https://chatgpt.com/connector/oauth/test")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Save settings") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("OAuth client secret")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes("OAuth client secret") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("custom-client-secret")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Save settings") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Generate access password")
  setup.mockInput.pressEnter()
  setup.mockInput.pressKey("u", { ctrl: true })
  await setup.waitForFrame(
    (frame) => frame.includes("New value") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Save settings")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => requests.length === 1)
  expect(requests[0]).toEqual({
    path: "/api/mcp/relay",
    method: "PUT",
    body: {
      settings: {
        issuer: "https://relay.example",
        hostname: "127.0.0.1",
        port: 4099,
        clientID: "opencode-relay",
        redirectURIs: ["https://chatgpt.com/connector/oauth/test"],
      },
      clientSecret: "custom-client-secret",
      password: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  })
  setup.mockInput.pressEscape()
  await setup.waitForFrame(
    (frame) => frame.includes("Build") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  setup.mockInput.pressKey("F9")
  await setup.waitForFrame(
    (frame) =>
      frame.includes("External model") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("Inspect this repository")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => requests.some((request) => request.path.endsWith("/prompt")))
  expect(requests.map((request) => request.path)).toEqual([
    "/api/mcp/relay",
    "/api/mcp/relay/start",
    `/api/session/${session.id}/prompt`,
  ])
  expect(requests[2]?.body).toMatchObject({ text: "Inspect this repository" })
  setup.resize(44, 40)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("MCP Relay")
})
