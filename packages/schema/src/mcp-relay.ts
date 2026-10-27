export * as McpRelay from "./mcp-relay.js"

import { Schema } from "effect"
import { ConfigMcpRelay } from "./config/mcp-relay.js"
import { Session } from "./session.js"
import { AbsolutePath } from "./schema.js"

export const Status = Schema.Struct({
  running: Schema.Boolean,
  settings: Schema.optionalKey(ConfigMcpRelay.Info),
  sessionID: Schema.optionalKey(Session.ID),
  directory: Schema.optionalKey(AbsolutePath),
  url: Schema.optionalKey(Schema.String),
  localURL: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "McpRelay.Status" })
export type Status = typeof Status.Type

export const Secrets = Schema.Struct({
  clientSecret: Schema.String,
  password: Schema.String,
  apiKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "McpRelay.Secrets" })

export const Configure = Schema.Struct({
  settings: ConfigMcpRelay.Info,
  clientSecret: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "McpRelay.Configure" })
export type Configure = typeof Configure.Type
