import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

export * as McpOAuth from "./oauth"

export interface Options {
  readonly issuer: string
  readonly clientID: string
  readonly clientSecret: string
  readonly password: string
  readonly redirectURIs: ReadonlyArray<string>
  readonly tokenFile?: string
}

type Authorization = {
  redirectURI: string
  challenge: string
  state: string
  expires: number
}

const scope = "opencode:tools"
const accessLifetime = 60 * 60
const refreshLifetime = 30 * 24 * 60 * 60
const decodeTokens = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      binding: Schema.String,
      access: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
      refresh: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
    }),
  ),
)

export function make(options: Options) {
  const issuer = new URL(options.issuer)
  if (
    issuer.protocol !== "https:" &&
    !(issuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname))
  )
    throw new Error("MCP OAuth issuer must use HTTPS (HTTP is allowed only on loopback)")
  if (issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password)
    throw new Error("MCP OAuth issuer must be an origin without a path, credentials, query, or fragment")
  if (!options.clientID || !options.clientSecret || !options.password || options.redirectURIs.length === 0)
    throw new Error("MCP OAuth requires client ID, client secret, password, and redirect URIs")
  options.redirectURIs.forEach((value) => {
    const url = new URL(value)
    if (
      url.hash ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("MCP OAuth redirect URIs must use HTTPS (HTTP is allowed only on loopback)")
  })

  const origin = issuer.origin
  const resource = `${origin}/mcp`
  const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`
  const pending = new Map<string, Authorization>()
  const codes = new Map<string, Authorization>()
  const binding = digest(JSON.stringify([origin, options.clientID, options.clientSecret, options.password, scope]))
  const stored =
    options.tokenFile && existsSync(options.tokenFile)
      ? decodeTokens(readFileSync(options.tokenFile, "utf8"))
      : undefined
  const access = new Map(stored?.binding === binding ? stored.access.filter((entry) => entry[1] > Date.now()) : [])
  const refresh = new Map(stored?.binding === binding ? stored.refresh.filter((entry) => entry[1] > Date.now()) : [])
  const headers = { "cache-control": "no-store", pragma: "no-cache" }
  const failure = (error: string, description: string, status = 400) =>
    Response.json({ error, error_description: description }, { status, headers })

  const issue = () => {
    const token = randomBytes(32).toString("base64url")
    const renewal = randomBytes(32).toString("base64url")
    access.set(digest(token), Date.now() + accessLifetime * 1_000)
    refresh.set(digest(renewal), Date.now() + refreshLifetime * 1_000)
    if (options.tokenFile) {
      mkdirSync(path.dirname(options.tokenFile), { recursive: true, mode: 0o700 })
      const temporary = `${options.tokenFile}.${randomBytes(8).toString("hex")}.tmp`
      // Commit the rotated refresh token before replying, so restart cannot revive the old one.
      // Only token hashes are stored; the atomic replacement also keeps file permissions private.
      writeFileSync(temporary, JSON.stringify({ version: 1, binding, access: [...access], refresh: [...refresh] }), {
        mode: 0o600,
        flag: "wx",
      })
      renameSync(temporary, options.tokenFile)
    }
    return Response.json(
      { access_token: token, token_type: "Bearer", expires_in: accessLifetime, refresh_token: renewal, scope },
      { headers },
    )
  }

  return {
    resource,
    scope,
    authorize(request: Request) {
      const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      if (token && (access.get(digest(token)) ?? 0) > Date.now()) return
      return Response.json(
        { error: "invalid_token" },
        {
          status: 401,
          headers: {
            ...headers,
            "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${scope}", error="invalid_token"`,
          },
        },
      )
    },
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      if (!url.pathname.startsWith("/oauth/") && !url.pathname.startsWith("/.well-known/")) return
      // Pending consent forms and authorization codes remain process-local; issued tokens can be persisted.
      pending.forEach((value, key) => {
        if (value.expires <= Date.now()) pending.delete(key)
      })
      codes.forEach((value, key) => {
        if (value.expires <= Date.now()) codes.delete(key)
      })
      access.forEach((expires, key) => {
        if (expires <= Date.now()) access.delete(key)
      })
      refresh.forEach((expires, key) => {
        if (expires <= Date.now()) refresh.delete(key)
      })

      if (
        request.method === "GET" &&
        ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)
      )
        return Response.json(
          {
            resource,
            authorization_servers: [origin],
            scopes_supported: [scope],
            bearer_methods_supported: ["header"],
          },
          { headers },
        )
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json(
          {
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: [scope],
            authorization_response_iss_parameter_supported: true,
          },
          { headers },
        )

      if (url.pathname === "/oauth/authorize" && request.method === "GET") {
        const params = url.searchParams
        const redirectURI = params.get("redirect_uri") ?? ""
        if (params.get("client_id") !== options.clientID || !options.redirectURIs.includes(redirectURI))
          return failure("invalid_request", "Unknown client or redirect URI")
        const redirectError = (error: string) => {
          const redirect = new URL(redirectURI)
          redirect.searchParams.set("error", error)
          redirect.searchParams.set("state", params.get("state") ?? "")
          redirect.searchParams.set("iss", origin)
          return Response.redirect(redirect.href, 303)
        }
        if (params.get("response_type") !== "code") return redirectError("unsupported_response_type")
        if (params.get("resource") !== resource) return redirectError("invalid_target")
        if (params.get("scope") && params.get("scope") !== scope) return redirectError("invalid_scope")
        if (
          params.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")
        )
          return redirectError("invalid_request")
        const transaction = randomBytes(32).toString("base64url")
        pending.set(transaction, {
          redirectURI,
          challenge: params.get("code_challenge")!,
          state: params.get("state") ?? "",
          expires: Date.now() + 5 * 60_000,
        })
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect OpenCode MCP</title><h1>Connect OpenCode MCP</h1><p>This connection grants full access to files and commands on this machine.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="transaction" value="${transaction}"><label>MCP access password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit" name="decision" value="allow">Allow access</button><button type="submit" name="decision" value="deny" formnovalidate>Cancel</button></form></html>`,
          {
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                // Chromium applies form-action to the callback redirect as well as the form POST.
                `default-src 'none'; form-action 'self' ${new URL(redirectURI).origin}; frame-ancestors 'none'; base-uri 'none'`,
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
            },
          },
        )
      }

      if (request.method !== "POST") return new Response("Not found", { status: 404 })
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
        return failure("invalid_request", "Expected a form-encoded request")
      const params = new URLSearchParams(await request.text())
      if (url.pathname === "/oauth/authorize") {
        // The random, one-use transaction binds the form to its authorization request.
        // Embedded browsers can submit an opaque Origin, so it is not an additional gate.
        const transaction = params.get("transaction") ?? ""
        const authorization = pending.get(transaction)
        if (!authorization) return failure("invalid_request", "Authorization request expired; start linking again")
        if (params.get("decision") !== "deny" && !equal(params.get("password") ?? "", options.password))
          return failure("access_denied", "Incorrect MCP access password", 403)
        pending.delete(transaction)
        const redirect = new URL(authorization.redirectURI)
        redirect.searchParams.set("state", authorization.state)
        redirect.searchParams.set("iss", origin)
        if (params.get("decision") === "deny") {
          redirect.searchParams.set("error", "access_denied")
          return Response.redirect(redirect.href, 303)
        }
        const code = randomBytes(32).toString("base64url")
        codes.set(digest(code), { ...authorization, expires: Date.now() + 60_000 })
        redirect.searchParams.set("code", code)
        return Response.redirect(redirect.href, 303)
      }

      if (url.pathname !== "/oauth/token") return new Response("Not found", { status: 404 })
      const basic = /^Basic (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const credentials = basic ? Buffer.from(basic, "base64").toString("utf8") : undefined
      const separator = credentials?.indexOf(":") ?? -1
      const clientID = credentials
        ? (new URLSearchParams(`value=${credentials.slice(0, separator)}`).get("value") ?? "")
        : (params.get("client_id") ?? "")
      const clientSecret = credentials
        ? (new URLSearchParams(`value=${credentials.slice(separator + 1)}`).get("value") ?? "")
        : (params.get("client_secret") ?? "")
      if (!equal(clientID, options.clientID) || !equal(clientSecret, options.clientSecret))
        return Response.json(
          { error: "invalid_client" },
          { status: 401, headers: { ...headers, "www-authenticate": 'Basic realm="OpenCode MCP"' } },
        )
      if (params.get("resource") !== resource) return failure("invalid_target", "Incorrect MCP resource")
      if (params.get("grant_type") === "refresh_token") {
        const token = digest(params.get("refresh_token") ?? "")
        if ((refresh.get(token) ?? 0) <= Date.now()) return failure("invalid_grant", "Invalid or expired refresh token")
        refresh.delete(token)
        return issue()
      }
      if (params.get("grant_type") !== "authorization_code")
        return failure("unsupported_grant_type", "Unsupported grant type")
      const code = digest(params.get("code") ?? "")
      const authorization = codes.get(code)
      codes.delete(code)
      const verifier = params.get("code_verifier") ?? ""
      if (
        !authorization ||
        authorization.redirectURI !== params.get("redirect_uri") ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !equal(authorization.challenge, createHash("sha256").update(verifier).digest("base64url"))
      )
        return failure("invalid_grant", "Invalid code, redirect URI, or PKCE verifier")
      return issue()
    },
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function equal(actual: string, expected: string) {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest())
}
