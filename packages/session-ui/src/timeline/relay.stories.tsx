import type { SessionDocument } from "../document"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { CURRENT_SESSION_ID, STORY_TIME } from "../storybook/current-session-fixtures"
import { CurrentSessionProviders } from "../storybook/current-session-story"
import { timelinePresets } from "./detail"
import { SessionTimeline } from "./session-timeline"

export default {
  title: "OpenCode/Conversation/MCP Relay",
  id: "current-session-relay",
  component: SessionTimeline,
  parameters: { layout: "fullscreen" },
}

export const Actions = {
  render: () => {
    const [document, setDocument] = createStore<SessionDocument>({
      sessionID: CURRENT_SESSION_ID,
      status: { type: "idle" },
      diffs: [],
      messages: [
        {
          id: "msg_relay_shell",
          type: "tool",
          metadata: { source: "mcp", summary: "Check the project before making changes" },
          tool: {
            type: "tool",
            id: "tool_relay_shell",
            name: "shell",
            state: {
              status: "running",
              input: { command: "git status --short" },
              metadata: { output: "Checking project files" },
            },
            time: { created: STORY_TIME, ran: STORY_TIME },
          },
          time: { created: STORY_TIME },
        },
        {
          id: "msg_relay_legacy",
          type: "tool",
          metadata: { source: "mcp" },
          tool: {
            type: "tool",
            id: "tool_relay_legacy",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "echo legacy" },
              metadata: {},
              content: [{ type: "text", text: "Legacy command output" }],
            },
            time: { created: STORY_TIME + 1, ran: STORY_TIME + 1, completed: STORY_TIME + 2 },
          },
          time: { created: STORY_TIME + 1 },
        },
        {
          id: "msg_regular_notice",
          type: "system",
          text: "Ordinary updates stay grouped",
          description: "Ordinary updates stay grouped",
          time: { created: STORY_TIME + 3 },
        },
      ],
    })
    return (
      <section class="mx-auto min-h-screen w-full max-w-[720px] bg-v2-background-bg-base p-6">
        <Button
          onClick={() =>
            setDocument("messages", 0, (message) =>
              message.type !== "tool"
                ? message
                : {
                    ...message,
                    tool: {
                      ...message.tool,
                      state: {
                        status: "completed",
                        input: { command: "git status --short" },
                        metadata: {},
                        content: [{ type: "text", text: "Working tree is clean" }],
                      },
                    },
                  },
            )
          }
        >
          Complete command
        </Button>
        <CurrentSessionProviders document={document}>
          <SessionTimeline
            document={document}
            timelineDetail={timelinePresets.find((preset) => preset.id === "compact")!.value}
          />
        </CurrentSessionProviders>
      </section>
    )
  },
}
