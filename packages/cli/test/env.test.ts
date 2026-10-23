import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  const previousMcpSecret = process.env.OPENCODE_MCP_OAUTH_CLIENT_SECRET
  const previousMcpPassword = process.env.OPENCODE_MCP_OAUTH_PASSWORD
  const previousUiPassword = process.env.OPENCODE_MCP_UI_PASSWORD
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"
  process.env.OPENCODE_MCP_OAUTH_CLIENT_SECRET = "mcp-secret"
  process.env.OPENCODE_MCP_OAUTH_PASSWORD = "mcp-password"
  process.env.OPENCODE_MCP_UI_PASSWORD = "ui-password"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue
  if (previousMcpSecret === undefined) delete process.env.OPENCODE_MCP_OAUTH_CLIENT_SECRET
  else process.env.OPENCODE_MCP_OAUTH_CLIENT_SECRET = previousMcpSecret
  if (previousMcpPassword === undefined) delete process.env.OPENCODE_MCP_OAUTH_PASSWORD
  else process.env.OPENCODE_MCP_OAUTH_PASSWORD = previousMcpPassword
  if (previousUiPassword === undefined) delete process.env.OPENCODE_MCP_UI_PASSWORD
  else process.env.OPENCODE_MCP_UI_PASSWORD = previousUiPassword

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
  expect(environment.OPENCODE_MCP_OAUTH_CLIENT_SECRET).toBeUndefined()
  expect(environment.OPENCODE_MCP_OAUTH_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_MCP_UI_PASSWORD).toBeUndefined()
})
