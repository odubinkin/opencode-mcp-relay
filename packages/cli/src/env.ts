import { Config } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

export const mcpOAuth = Config.all({
  issuer: Config.String("OPENCODE_MCP_OAUTH_ISSUER").pipe(Config.withDefault("")),
  clientID: Config.String("OPENCODE_MCP_OAUTH_CLIENT_ID").pipe(Config.withDefault("")),
  clientSecret: Config.Redacted("OPENCODE_MCP_OAUTH_CLIENT_SECRET").pipe(Config.withDefault(undefined)),
  password: Config.Redacted("OPENCODE_MCP_OAUTH_PASSWORD").pipe(Config.withDefault(undefined)),
  redirectURIs: Config.String("OPENCODE_MCP_OAUTH_REDIRECT_URIS").pipe(Config.withDefault("")),
  tokenFile: Config.String("OPENCODE_MCP_OAUTH_TOKEN_FILE").pipe(Config.withDefault(undefined)),
})

export const mcpRuntime = Config.all({
  directory: Config.String("OPENCODE_MCP_DIRECTORY").pipe(Config.withDefault(undefined)),
  hostname: Config.String("OPENCODE_MCP_HOSTNAME").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Int("OPENCODE_MCP_PORT").pipe(Config.withDefault(4096)),
  stateDirectory: Config.String("OPENCODE_MCP_STATE_DIRECTORY").pipe(Config.withDefault(undefined)),
  agent: Config.String("OPENCODE_MCP_AGENT").pipe(Config.withDefault(undefined)),
  uiPort: Config.Int("OPENCODE_MCP_UI_PORT").pipe(Config.withDefault(4098)),
  uiPassword: Config.Redacted("OPENCODE_MCP_UI_PASSWORD").pipe(Config.withDefault(undefined)),
})

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "OPENCODE_PASSWORD" &&
        entry[0] !== "OPENCODE_SERVER_PASSWORD" &&
        entry[0] !== "OPENCODE_MCP_UI_PASSWORD" &&
        !entry[0].startsWith("OPENCODE_MCP_OAUTH_"),
    ),
  )
}

export * as Env from "./env"
