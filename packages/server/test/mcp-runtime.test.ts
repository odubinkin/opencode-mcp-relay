import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Form } from "@opencode/schema/form"
import { Permission } from "@opencode/schema/permission"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, Fiber, Queue, Schema } from "effect"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { McpRuntime } from "../src/mcp-runtime"

const decodeMessages = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.toEncoded(SessionMessage.Info)) }),
)

it.live(
  "restores the saved MCP session on restart and preserves it when the configured directory changes",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      const other = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      const open = (project: string, sessionID?: string) =>
        McpRuntime.make({
          directory: project,
          sessionID,
          server: {
            database: { path: path.join(directory.path, "opencode.sqlite") },
            config: { directory: path.join(directory.path, "config") },
            models: { fetch: false },
            fs: { filewatcher: false },
          },
        })
      const original = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* open(directory.path)
          expect(
            (yield* Effect.promise(() => runtime.execute("read", { path: "missing.txt" })).pipe(Effect.exit))._tag,
          ).toBe("Failure")
          return runtime.sessionID
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* open(directory.path, original)
          expect(runtime.sessionID).toBe(original)
          expect(yield* Effect.promise(() => runtime.context())).toMatchObject({ directory: directory.path })
          const history = yield* Effect.promise(async () =>
            decodeMessages(
              await (await runtime.fetch(new Request(`http://local/api/session/${original}/message`))).json(),
            ),
          )
          expect(history.data).toMatchObject([
            {
              type: "tool",
              tool: {
                name: "read",
                state: {
                  status: "error",
                  input: { path: "missing.txt" },
                  error: { message: expect.stringContaining("missing.txt") },
                },
              },
            },
          ])
        }),
      )
      const changed = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* open(other.path, original)
          expect(runtime.sessionID).not.toBe(original)
          expect(yield* Effect.promise(() => runtime.context())).toMatchObject({ directory: other.path })
          expect(
            yield* Effect.promise(async () =>
              (await runtime.fetch(new Request(`http://local/api/session/${original}`))).json(),
            ),
          ).toMatchObject({ data: { id: original, driver: "external", location: { directory: directory.path } } })
          return runtime.sessionID
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* open(other.path, changed)
          expect(runtime.sessionID).toBe(changed)
        }),
      )
    }),
  // Four full native application startups reopen the real SQLite database, including on Windows.
  { timeout: 30_000 },
)

it.live("shares native UI permissions and questions, including declines and cancellation, without a model", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
    const runtime = yield* McpRuntime.make({
      directory: directory.path,
      server: {
        password: "ui-secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        fs: { filewatcher: false },
        config: {
          directory: path.join(directory.path, "config"),
          content: JSON.stringify({
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "edit", resource: "*", effect: "ask" },
            ],
          }),
        },
      },
    })
    const permission = yield* Deferred.make<Permission.ID, unknown>()
    const question = yield* Queue.unbounded<{ readonly id: Form.ID }, unknown>()
    const unsubscribe = yield* Effect.promise(() =>
      runtime.run(
        Bus.Service.use((bus) =>
          bus.listen((event) => {
            if (event.type === "permission.asked")
              return Deferred.succeed(
                permission,
                Schema.decodeUnknownSync(Schema.Struct({ id: Permission.ID }))(event.data).id,
              ).pipe(Effect.asVoid)
            if (event.type === "form.created")
              return Queue.offer(
                question,
                Schema.decodeUnknownSync(Schema.Struct({ form: Schema.Struct({ id: Form.ID }) }))(event.data).form,
              ).pipe(Effect.asVoid)
            return Effect.void
          }),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const request = (endpoint: string, body?: unknown) =>
      runtime.fetch(
        new Request(`http://opencode.local${endpoint}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Basic ${btoa("opencode:ui-secret")}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    expect((yield* Effect.promise(() => runtime.fetch(new Request("http://local/api/session")))).status).toBe(401)
    const target = path.join(directory.path, "approved.txt")
    const write = yield* Effect.promise(() => runtime.execute("write", { path: target, content: "approved" })).pipe(
      Effect.tapCause((cause) => Deferred.failCause(permission, cause)),
      Effect.tap(() => Deferred.fail(permission, new Error("Write completed without asking permission"))),
      Effect.forkScoped,
    )
    const pending = yield* Deferred.await(permission)
    expect(
      yield* Effect.promise(async () =>
        decodeMessages(await (await request(`/api/session/${runtime.sessionID}/message`)).json()),
      ),
    ).toMatchObject({
      data: [
        {
          type: "tool",
          tool: { name: "write", state: { status: "running", input: { path: target, content: "approved" } } },
        },
      ],
    })
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    expect(
      yield* Effect.promise(async () => (await request(`/api/session/${runtime.sessionID}/permission`)).json()),
    ).toMatchObject({ data: [{ id: pending }] })
    expect(
      (yield* Effect.promise(() =>
        request(`/api/session/${runtime.sessionID}/permission/${pending}/reply`, { decision: "once" }),
      )).status,
    ).toBe(204)
    yield* Fiber.join(write)
    expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("approved")
    const ask = yield* Effect.promise(() =>
      runtime.execute("question", {
        questions: [
          { question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] },
        ],
      }),
    ).pipe(
      Effect.tapCause((cause) => Queue.failCause(question, cause)),
      Effect.forkScoped,
    )
    const form = yield* Queue.take(question)
    expect(
      (yield* Effect.promise(() =>
        request(`/api/session/${runtime.sessionID}/form/${form.id}/reply`, { answer: { q0: "Yes" } }),
      )).status,
    ).toBe(204)
    expect((yield* Fiber.join(ask)).content).toEqual([
      { type: "text", text: expect.stringContaining('"Continue?"="Yes"') },
    ])

    const dismissed = yield* Effect.promise(() =>
      runtime.execute("question", { questions: [{ question: "Dismiss?", header: "Dismiss", options: [] }] }),
    ).pipe(Effect.forkScoped)
    const dismissal = yield* Queue.take(question)
    const dismissedReply = yield* Effect.promise(() =>
      runtime.fetch(
        new Request(`http://opencode.local/api/session/${runtime.sessionID}/form/${dismissal.id}`, {
          method: "DELETE",
          headers: { authorization: `Basic ${btoa("opencode:ui-secret")}` },
        }),
      ),
    )
    expect(dismissedReply.status).toBe(204)
    expect((yield* Fiber.await(dismissed))._tag).toBe("Failure")

    // Cancellation of an active request closes the same native form the UI is displaying.
    const cancelled = new AbortController()
    const interrupted = yield* Effect.promise(() =>
      runtime.execute(
        "question",
        { questions: [{ question: "Cancelled?", header: "Cancel", options: [] }] },
        { signal: cancelled.signal },
      ),
    ).pipe(Effect.forkScoped)
    const active = yield* Queue.take(question)
    cancelled.abort()
    expect((yield* Fiber.await(interrupted))._tag).toBe("Failure")
    expect(
      yield* Effect.promise(async () => (await request(`/api/session/${runtime.sessionID}/form/${active.id}`)).json()),
    ).toMatchObject({ data: { state: { status: "cancelled" } } })
    expect((yield* Effect.promise(() => runtime.catalog())).map((tool) => tool.name)).not.toContain("subagent")
    const events = yield* Effect.promise(async () =>
      decodeMessages(await (await request(`/api/session/${runtime.sessionID}/message`)).json()),
    )
    expect(JSON.stringify(events)).not.toContain('"type":"assistant"')
    expect(JSON.stringify(events)).toContain('"source":"mcp"')
    const tools = events.data.flatMap((message) => (message.type === "tool" ? [message.tool] : []))
    expect(tools.find((tool) => tool.name === "write")).toMatchObject({
      state: {
        status: "completed",
        input: { path: target },
        content: [{ type: "text", text: expect.stringContaining("approved.txt") }],
      },
    })
    expect(tools.filter((tool) => tool.state.status === "error")).toMatchObject([
      { name: "question", state: { error: { type: "aborted" } } },
      { name: "question", state: { error: { type: "aborted" } } },
    ])
  }),
)
