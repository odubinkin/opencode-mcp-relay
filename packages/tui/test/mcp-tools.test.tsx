import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"

test.each([100, 44])("renders standalone native tool cards from history and live events at width %s", async (width) => {
  const session = {
    id: "ses_mcp_tools",
    title: "MCP tools",
    projectID: "project",
    driver: "external",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  await using setup = await createAppFixture({
    width,
    height: 45,
    config: { animations: false, session: { sidebar: "hide", grouping: "none" } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [
            {
              id: "msg_read",
              type: "tool",
              time: { created: 1 },
              tool: {
                type: "tool",
                id: "call_read",
                name: "read",
                time: { created: 1, completed: 2 },
                state: {
                  status: "completed",
                  input: { path: "src/file.ts", offset: 3, limit: 2 },
                  content: [{ type: "text", text: "read" }],
                },
              },
            },
          ],
          cursor: {},
        })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("file.ts") && frame.includes("3-4"))
  setup.events.emit({
    type: "session.tool.started",
    id: "evt_shell_started",
    created: 3,
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_shell",
      id: "call_shell",
      name: "shell",
      input: { command: "echo native-output" },
    },
  })
  await setup.waitForFrame((frame) => frame.includes("echo native-output"))
  setup.events.emit({
    type: "session.tool.success",
    id: "evt_shell_completed",
    created: 4,
    durable: { aggregateID: session.id, seq: 2, version: 2 },
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_shell",
      id: "call_shell",
      executed: false,
      content: [{ type: "text", text: "native-output-result" }],
      metadata: { exit: 0 },
    },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes("native-output-result"))
  expect(setup.captureCharFrame()).not.toContain("MCP: shell")
})
