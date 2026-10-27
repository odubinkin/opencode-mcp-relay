export * as ConfigMcpRelay from "./mcp-relay.js"

import { Schema } from "effect"

/** Server-global settings only. Secrets belong to Credential, never repository configuration. */
export const Info = Schema.Struct({
  issuer: Schema.String,
  hostname: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  clientID: Schema.String,
  redirectURIs: Schema.Array(Schema.String),
  /** Optional private OpenAI Secure MCP Tunnel; no public proxy is required. */
  tunnelID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Config.McpRelay" })
export type Info = typeof Info.Type
