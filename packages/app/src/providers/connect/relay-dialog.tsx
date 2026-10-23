import type { ConfigMcpRelay, McpRelayStatus } from "@opencode/client/promise"
import { For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextField } from "@opencode/ui/text-field"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"

export function DialogMcpRelay(props: { directory?: string; start?: boolean }) {
  const sdk = useServerSDK()
  const data = useData()
  const tabs = useTabs()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const location = { directory: props.directory ?? data.location.default().directory }
  const [state, setState] = createStore<{
    status?: McpRelayStatus
    settings: ConfigMcpRelay
    callbacks: string
    secrets: { clientSecret: string; password: string }
    revealed: { clientSecret: boolean; password: boolean }
    busy: boolean
    error?: string
    copied: boolean
  }>({
    settings: { issuer: "", hostname: "127.0.0.1", port: 4099, clientID: "opencode-relay", redirectURIs: [] },
    callbacks: "",
    secrets: { clientSecret: "", password: "" },
    revealed: { clientSecret: false, password: false },
    busy: true,
    copied: false,
  })
  const failure = (error: unknown) =>
    setState({ busy: false, error: error instanceof Error ? error.message : String(error) })
  const open = (status: McpRelayStatus, close = true) => {
    if (!status.sessionID || !status.directory) return
    const tab = tabs.addSessionTab({ server: ServerConnection.key(sdk.server), sessionId: status.sessionID })
    tabs.select(tab)
    if (close) dialog.close()
  }
  const start = async (close = true) => {
    setState({ busy: true, error: undefined })
    const status = await sdk.api.mcp.relay.start({ location })
    setState({ status, busy: false })
    open(status, close)
  }
  onMount(() => {
    void sdk.api.mcp.relay
      .status({ location })
      .then(async (status) => {
        const secrets = status.settings ? await sdk.api.mcp.relay.secrets({ location }) : state.secrets
        setState({
          status,
          secrets,
          settings: status.settings ?? state.settings,
          callbacks: status.settings?.redirectURIs.join("\n") ?? "",
          busy: false,
        })
        if (!props.start || !status.settings) return
        if (status.running) return open(status, false)
        await start()
      })
      .catch(failure)
  })
  const save = async (launch = false) => {
    setState({ busy: true, error: undefined })
    // Editing is local until the user explicitly saves; a running listener needs a restart.
    if (state.status?.running) {
      setState("status", await sdk.api.mcp.relay.stop({ location }))
    }
    const status = await sdk.api.mcp.relay.configure({
      location,
      settings: {
        ...state.settings,
        redirectURIs: state.callbacks
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      },
      ...(state.secrets.clientSecret ? { clientSecret: state.secrets.clientSecret } : {}),
      ...(state.secrets.password ? { password: state.secrets.password } : {}),
    })
    const secrets = await sdk.api.mcp.relay.secrets({ location })
    setState({ status, settings: status.settings ?? state.settings, secrets, busy: false })
    if (launch) await start(false)
  }
  const issuer = () => state.status?.settings?.issuer.replace(/\/$/, "") ?? ""
  const copy = async (
    kind: "url" | "authURL" | "tokenURL" | "issuer" | "resource" | "clientID" | "clientSecret" | "password",
  ) => {
    const value = {
      url: `${issuer()}/mcp`,
      authURL: `${issuer()}/oauth/authorize`,
      tokenURL: `${issuer()}/oauth/token`,
      issuer: issuer(),
      resource: `${issuer()}/mcp`,
      clientID: state.status?.settings?.clientID ?? "",
      ...state.secrets,
    }[kind]
    if (platform.writeClipboardText) await platform.writeClipboardText(value)
    else await navigator.clipboard.writeText(value)
    setState("copied", true)
  }
  return (
    <Dialog
      containerClass="!w-[min(calc(100vw_-_32px),640px)] !h-[min(calc(100dvh_-_32px),760px)]"
      class="!overflow-hidden min-h-0"
    >
      <DialogHeader>
        <DialogTitleGroup title={language.t("relay.title")} description={language.t("relay.description")} />
      </DialogHeader>
      <DialogBody class="min-h-0">
        <div class="flex flex-col gap-4 p-4 overflow-y-auto min-h-0 flex-1">
          <p role="status">
            {language.t(state.busy ? "relay.loading" : state.status?.running ? "relay.running" : "relay.stopped")}
          </p>
          <Show when={state.status?.directory}>
            <p class="break-all">{state.status?.directory}</p>
          </Show>
          <Show when={state.status?.running}>
            <p>{language.t("relay.restartHint")}</p>
          </Show>
          <fieldset disabled={state.busy} class="flex flex-col gap-3">
            <TextField
              label={language.t("relay.issuer")}
              value={state.settings.issuer}
              placeholder={language.t("relay.issuerPlaceholder")}
              onChange={(value) => setState("settings", "issuer", value)}
            />
            <TextField
              label={language.t("relay.hostname")}
              value={state.settings.hostname}
              onChange={(value) => setState("settings", "hostname", value)}
            />
            <TextField
              label={language.t("relay.port")}
              type="number"
              value={String(state.settings.port)}
              onChange={(value) => setState("settings", "port", Number(value))}
            />
            <TextField
              label={language.t("relay.clientID")}
              value={state.settings.clientID}
              onChange={(value) => setState("settings", "clientID", value)}
            />
            <TextField
              label={language.t("relay.callbacks")}
              multiline
              value={state.callbacks}
              onChange={(value) => setState("callbacks", value)}
            />
            <For each={["clientSecret", "password"] as const}>
              {(kind) => (
                <div class="flex flex-col gap-2">
                  <TextField
                    label={language.t(kind === "clientSecret" ? "relay.clientSecret" : "relay.password")}
                    type={state.revealed[kind] ? "text" : "password"}
                    autocomplete="new-password"
                    value={state.secrets[kind]}
                    placeholder={language.t("relay.secretPlaceholder")}
                    onChange={(value) => setState("secrets", kind, value)}
                  />
                  <div class="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      class="self-start"
                      aria-label={language.t(
                        kind === "clientSecret" ? "relay.generateSecret" : "relay.generatePassword",
                      )}
                      onClick={() =>
                        setState(
                          "secrets",
                          kind,
                          Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
                            byte.toString(16).padStart(2, "0"),
                          ).join(""),
                        )
                      }
                    >
                      {language.t("relay.generate")}
                    </Button>
                    <Button
                      type="button"
                      disabled={!state.secrets[kind]}
                      aria-label={language.t(
                        kind === "clientSecret"
                          ? state.revealed[kind]
                            ? "relay.hideSecret"
                            : "relay.showSecret"
                          : state.revealed[kind]
                            ? "relay.hidePassword"
                            : "relay.showPassword",
                      )}
                      aria-pressed={state.revealed[kind]}
                      onClick={() => setState("revealed", kind, !state.revealed[kind])}
                    >
                      {language.t(state.revealed[kind] ? "relay.hide" : "relay.show")}
                    </Button>
                    <Button
                      type="button"
                      disabled={!state.secrets[kind]}
                      aria-label={language.t(kind === "clientSecret" ? "relay.copySecret" : "relay.copyPassword")}
                      onClick={() => void copy(kind).catch(failure)}
                    >
                      {language.t("relay.copy")}
                    </Button>
                  </div>
                </div>
              )}
            </For>
            <p>{language.t("relay.secretHint")}</p>
          </fieldset>
          <Show when={state.error}>
            <p role="alert" class="text-text-critical-base">
              {state.error}
            </p>
          </Show>
          <Show when={state.status?.settings}>
            <p>{language.t("relay.credentials", { issuer: issuer() })}</p>
            <div class="flex flex-wrap gap-2">
              <For
                each={
                  [
                    { kind: "url", label: "relay.copyURL" },
                    { kind: "authURL", label: "relay.copyAuthURL" },
                    { kind: "tokenURL", label: "relay.copyTokenURL" },
                    { kind: "issuer", label: "relay.copyIssuer" },
                    { kind: "resource", label: "relay.copyResource" },
                    { kind: "clientID", label: "relay.copyClientID" },
                  ] as const
                }
              >
                {(item) => (
                  <Button disabled={state.busy} onClick={() => void copy(item.kind).catch(failure)}>
                    {language.t(item.label)}
                  </Button>
                )}
              </For>
            </div>
          </Show>
          <Show when={state.copied}>
            <p role="status">{language.t("relay.copied")}</p>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <div class="flex flex-wrap gap-2 w-full">
          <Button disabled={state.busy} onClick={() => void save(!!state.status?.running).catch(failure)}>
            {language.t(state.status?.running ? "relay.saveRestart" : "relay.save")}
          </Button>
          <Show when={!state.status?.running}>
            <Button disabled={state.busy} onClick={() => void save(true).catch(failure)}>
              {language.t("relay.saveStart")}
            </Button>
          </Show>
          <Show when={state.status?.running}>
            <Button disabled={state.busy} onClick={() => state.status && open(state.status)}>
              {language.t("relay.open")}
            </Button>
            <Button
              disabled={state.busy}
              onClick={() => {
                setState("busy", true)
                void sdk.api.mcp.relay
                  .stop({ location })
                  .then((status) => setState({ status, busy: false }))
                  .catch(failure)
              }}
            >
              {language.t("relay.stop")}
            </Button>
          </Show>
        </div>
      </DialogFooter>
    </Dialog>
  )
}
