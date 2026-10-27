import type { ConfigMcpRelay, McpRelayStatus } from "@opencode/client"
import { createEffect, createMemo, on, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useClient } from "../context/client"
import { useClipboard } from "../context/clipboard"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useSessionTabs } from "../context/session-tabs"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { randomBytes } from "node:crypto"

export function DialogMcpRelay(props: { start?: boolean } = {}) {
  const client = useClient()
  const clipboard = useClipboard()
  const data = useData()
  const location = useLocation()
  const route = useRoute()
  const tabs = useSessionTabs()
  const dialog = useDialog()
  const toast = useToast()
  // Keep setup and the external model bound to the project where the command was invoked.
  const target = location.ref ?? data.location.default()
  const [state, setState] = createStore<{
    status?: McpRelayStatus
    settings: ConfigMcpRelay
    clientSecret: string
    password: string
    apiKey: string
    busy: boolean
    edit?: { title: string; value: string; save: (value: string) => void }
  }>({
    settings: { issuer: "", hostname: "127.0.0.1", port: 4099, clientID: "opencode-relay", redirectURIs: [] },
    clientSecret: "",
    password: "",
    apiKey: "",
    busy: true,
  })
  const failure = (error: unknown) => {
    setState("busy", false)
    toast.show({ title: "MCP Relay", message: errorMessage(error), variant: "error" })
  }
  const open = (status: McpRelayStatus, close = true) => {
    if (!status.sessionID) return
    tabs.open(status.sessionID)
    route.navigate({ type: "session", sessionID: status.sessionID })
    if (close) dialog.clear()
  }
  const start = async () => {
    setState("busy", true)
    const status = await client.api.mcp.relay.start({ location: target })
    setState({ status, busy: false })
    open(status)
  }
  onMount(() => {
    void client.api.mcp.relay
      .status({ location: target })
      .then(async (status) => {
        setState({ status, settings: status.settings ?? state.settings, busy: false })
      })
      .catch(failure)
  })
  // A reused dialog instance may receive start=true after its original onMount ran.
  createEffect(
    on([() => props.start, () => state.status?.settings], ([requested, settings]) => {
      if (!requested || !settings) return
      if (state.status?.running) return open(state.status, false)
      void start().catch(failure)
    }),
  )
  const edit = (title: string, value: string, save: (value: string) => void) => {
    setState("edit", { title, value, save })
  }
  const copy = async (value: string) => {
    await clipboard.write(value)
    toast.show({ title: "MCP Relay", message: "Copied to clipboard", variant: "info" })
  }
  const save = async (launch = false) => {
    setState("busy", true)
    const status = await client.api.mcp.relay.configure({
      location: target,
      settings: state.settings,
      ...(state.clientSecret ? { clientSecret: state.clientSecret } : {}),
      ...(state.password ? { password: state.password } : {}),
      ...(state.apiKey ? { apiKey: state.apiKey } : {}),
    })
    setState({ status, busy: false, clientSecret: "", password: "" })
    if (launch) await start()
  }
  const options = createMemo(() => [
    {
      title: "Save settings",
      value: "save",
      category: "Settings",
      disabled: state.busy || state.status?.running,
      onSelect: () => {
        void save().catch(failure)
      },
    },
    {
      title: state.status?.running ? "Open Relay session" : "Save settings and start Relay",
      value: "start",
      category: "Relay",
      disabled: state.busy,
      onSelect: () => {
        if (state.status?.running) return open(state.status)
        void save(true).catch(failure)
      },
    },
    {
      title: "Public URL (OAuth issuer)",
      footer: state.settings.issuer || "Required · https://your-domain",
      value: "issuer",
      category: "Settings",
      disabled: state.status?.running,
      onSelect: () =>
        edit("Public URL · origin without /mcp", state.settings.issuer, (value) =>
          setState("settings", "issuer", value),
        ),
    },
    {
      title: "Listen hostname",
      footer: state.settings.hostname,
      value: "hostname",
      category: "Settings",
      disabled: state.status?.running,
      onSelect: () =>
        edit("Listen hostname", state.settings.hostname, (value) => setState("settings", "hostname", value)),
    },
    {
      title: "Listen port",
      footer: String(state.settings.port),
      value: "port",
      category: "Settings",
      disabled: state.status?.running,
      onSelect: () =>
        edit("Listen port", String(state.settings.port), (value) => setState("settings", "port", Number(value))),
    },
    {
      title: "OAuth client ID",
      footer: state.settings.clientID,
      value: "clientID",
      category: "Settings",
      disabled: state.status?.running,
      onSelect: () =>
        edit("OAuth client ID", state.settings.clientID, (value) => setState("settings", "clientID", value)),
    },
    {
      title: "Callback URLs",
      footer: state.settings.redirectURIs.join(", ") || "Required · copy from ChatGPT",
      value: "redirects",
      category: "Settings",
      disabled: state.status?.running,
      onSelect: () =>
        edit("Callback URLs · one per line", state.settings.redirectURIs.join("\n"), (value) =>
          setState(
            "settings",
            "redirectURIs",
            value
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ),
    },
    {
      title: "OAuth client secret",
      footer: state.clientSecret ? "New value · save to apply" : "Open to replace · leave blank to keep saved value",
      value: "clientSecret",
      category: "Credentials",
      disabled: state.busy || state.status?.running,
      onSelect: () => edit("OAuth client secret", state.clientSecret, (value) => setState("clientSecret", value)),
    },
    {
      title: "Generate OAuth client secret",
      value: "generate-secret",
      category: "Credentials",
      disabled: state.busy || state.status?.running,
      onSelect: () => setState("clientSecret", randomBytes(32).toString("hex")),
    },
    {
      title: "Access password",
      footer: state.password ? "New value · save to apply" : "Open to replace · leave blank to keep saved value",
      value: "password-edit",
      category: "Credentials",
      disabled: state.busy || state.status?.running,
      onSelect: () => edit("Access password", state.password, (value) => setState("password", value)),
    },
    {
      title: "Generate access password",
      value: "generate-password",
      category: "Credentials",
      disabled: state.busy || state.status?.running,
      onSelect: () => setState("password", randomBytes(32).toString("hex")),
    },
    {
      title: "Copy MCP URL",
      footer: state.status?.url,
      value: "url",
      category: "Connection",
      disabled: !state.settings.issuer,
      onSelect: () => {
        void copy(`${state.settings.issuer.replace(/\/$/, "")}/mcp`).catch(failure)
      },
    },
    ...[
      { title: "Copy Auth URL", value: "auth-url", suffix: "/oauth/authorize" },
      { title: "Copy Token URL", value: "token-url", suffix: "/oauth/token" },
      { title: "Copy authorization server base", value: "issuer-url", suffix: "" },
      { title: "Copy Resource", value: "resource-url", suffix: "/mcp" },
    ].map((item) => ({
      title: item.title,
      value: item.value,
      category: "Connection",
      disabled: !state.settings.issuer,
      onSelect: () => {
        void copy(`${state.settings.issuer.replace(/\/$/, "")}${item.suffix}`).catch(failure)
      },
    })),
    {
      title: "Copy OAuth client secret",
      value: "secret",
      category: "Connection",
      disabled: !state.clientSecret && !state.status?.settings,
      onSelect: () => {
        if (state.clientSecret) {
          void copy(state.clientSecret).catch(failure)
          return
        }
        void client.api.mcp.relay
          .secrets({ location: target })
          .then((value) => copy(value.clientSecret))
          .catch(failure)
      },
    },
    {
      title: "Copy access password",
      value: "password",
      category: "Connection",
      disabled: !state.password && !state.status?.settings,
      onSelect: () => {
        if (state.password) {
          void copy(state.password).catch(failure)
          return
        }
        void client.api.mcp.relay
          .secrets({ location: target })
          .then((value) => copy(value.password))
          .catch(failure)
      },
    },
    {
      title: "Stop Relay",
      value: "stop",
      category: "Relay",
      disabled: state.busy || !state.status?.running,
      onSelect: () => {
        setState("busy", true)
        void client.api.mcp.relay
          .stop({ location: target })
          .then((status) => setState({ status, busy: false }))
          .catch(failure)
      },
    },
    {
      title: "OpenAI Secure MCP Tunnel ID",
      footer: state.settings.tunnelID || "Optional · connect ChatGPT without a public URL",
      value: "tunnelID",
      category: "Tunnel",
      disabled: state.status?.running,
      onSelect: () =>
        edit("OpenAI Tunnel ID · leave empty for public HTTPS mode", state.settings.tunnelID ?? "", (value) =>
          setState("settings", "tunnelID", value || undefined),
        ),
    },
    {
      title: "OpenAI API key",
      footer: state.apiKey ? "New value · save to apply" : "Leave blank to keep the saved key",
      value: "apiKey",
      category: "Tunnel",
      disabled: state.status?.running,
      onSelect: () => edit("OpenAI API key", state.apiKey, (value) => setState("apiKey", value)),
    },
  ])
  return (
    <Show
      when={state.edit}
      keyed
      fallback={
        <DialogSelect
          title={`MCP Relay Mode · ${state.busy ? "Loading…" : state.status?.running ? "Running" : "Stopped"}`}
          options={options()}
        />
      }
    >
      {(edit) => (
        <DialogPrompt
          title={edit.title}
          value={edit.value}
          onCancel={() => setState("edit", undefined)}
          onConfirm={(value) => {
            edit.save(value.trim())
            setState("edit", undefined)
          }}
        />
      )}
    </Show>
  )
}
