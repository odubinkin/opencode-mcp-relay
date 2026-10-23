export * as SessionExternal from "./external.js"

import { Cause, Effect, Ref, Semaphore, Stream } from "effect"
import { isReadonlyArrayNonEmpty } from "effect/Array"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instructions } from "../instructions/index.js"
import { Location } from "../location.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Permission } from "../permission.js"
import { Plugin } from "../plugin.js"
import { Session } from "../session.js"
import { Skill } from "../skill.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { SessionToolExecution } from "./tool-execution.js"
import { toSessionError } from "./to-session-error.js"

/** A model-independent driver. It shares the host's Location services, forms and Session history. */
export const open = Effect.fn("SessionExternal.open")(function* (input: {
  readonly id?: Session.ID
  readonly location: Location.Ref
  readonly agent?: Agent.ID
}) {
  const sessions = yield* Session.Service
  const locations = yield* LocationServiceMap.Service
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const updates = yield* Semaphore.make(1)
  const options = {
    location: input.location,
    agent: input.agent,
    driver: "external" as const,
    title: "MCP · external model",
  }
  const recorded = yield* sessions.create({ ...options, id: input.id })
  if (recorded.driver !== "external")
    return yield* Effect.fail(new Error("The saved MCP session belongs to a different driver"))
  // The configured root wins, but switching projects must not move or discard the old history.
  const session = recorded.location.directory === input.location.directory ? recorded : yield* sessions.create(options)
  if (session.id !== recorded.id)
    yield* Effect.logInfo("MCP directory changed; created a new session", {
      previousSessionID: recorded.id,
      previousDirectory: recorded.location.directory,
      sessionID: session.id,
      directory: session.location.directory,
    })

  const select = Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    return yield* context.select(session.id, "direct")
  })
  const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const current = yield* sessions.get(session.id)
      return yield* effect.pipe(Effect.provide(locations.get(current.location)))
    })
  const context = Effect.gen(function* () {
    const selection = yield* select
    const agents = yield* Agent.Service
    const skills = yield* Skill.Service
    const observed = yield* Instructions.read(selection.instructions)
    // Do not silently omit unreadable initial instructions.
    yield* Instructions.diff(observed)
    const values = Object.fromEntries(
      observed.flatMap((entry) =>
        entry.value === Instructions.removed || entry.value === Instructions.unavailable
          ? []
          : [[entry.key, entry.value]],
      ),
    )
    return {
      sessionID: session.id,
      directory: selection.session.location.directory,
      agent: selection.agent.id,
      system:
        selection.agent.info.system || SessionSystemPrompt.make(selection.tools.definitions.map((tool) => tool.name)),
      instructions: Instructions.renderInitial(selection.instructions, values),
      agents: yield* agents.list(),
      skills: Skill.available(
        yield* skills.list(),
        Permission.merge(selection.agent.info.permissions, selection.session.permissions ?? []),
      ).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
    }
  })

  return {
    sessionID: session.id,
    context: inLocation(context),
    catalog: inLocation(select.pipe(Effect.map((selection) => selection.tools.definitions))),
    /** Publish native pending input before returning it to the external driver, without waking an LLM. */
    updates: updates.withPermit(
      Effect.gen(function* () {
        const pending = yield* sessions.inbox(session.id)
        // Use the same promotion ordering as the native runner, but never compact through an LLM.
        for (const _ of pending) {
          const next = yield* SessionInbox.nextPromotable(database.db, session.id, "input")
          if (!next) break
          if (next.type === "compaction") {
            yield* bus.publish(SessionEvent.InboxCancelled, { sessionID: session.id, inboxID: next.id })
            continue
          }
          if (next.type === "move") {
            yield* bus.publishAll([
              [SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: next.id }],
              [SessionEvent.Moved, { sessionID: session.id, ...next.payload }],
            ])
            continue
          }
          yield* SessionInbox.promote(database.db, bus, session.id, "input")
        }
        return (yield* sessions.context(session.id)).filter(
          (message) =>
            (message.type === "synthetic" && message.metadata?.source !== "mcp") ||
            message.type === "user" ||
            message.type === "skill" ||
            message.type === "system",
        )
      }),
    ),
    execute: (
      name: string,
      args: Record<string, unknown>,
      options?: {
        readonly summary?: string
        readonly progress?: (metadata: Tool.Metadata) => Effect.Effect<void>
      },
    ) =>
      inLocation(
        Effect.gen(function* () {
          const selection = yield* select
          const output = yield* ToolOutput.Service
          const callID = Tool.CallID.make(crypto.randomUUID())
          const messageID = SessionMessage.ID.create()
          const progress = yield* Ref.make<Tool.Metadata>({})
          const owner = { sessionID: session.id, assistantMessageID: messageID, id: callID }
          // Reuse native tool cards and their lifecycle, without inventing an LLM Step or model usage.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* bus.publish(
                SessionEvent.Tool.Started,
                { ...owner, name, input: args },
                { metadata: { source: "mcp", ...(options?.summary ? { summary: options.summary } : {}) } },
              )
              return yield* restore(
                SessionToolExecution.execute(selection.tools, {
                  sessionID: session.id,
                  messageID,
                  agent: selection.agent.id,
                  call: { type: "tool-call", id: callID, name, input: args },
                  progress: (metadata) =>
                    Effect.gen(function* () {
                      yield* Ref.set(progress, metadata)
                      yield* bus.publish(SessionEvent.Tool.Progress, { ...owner, metadata })
                      if (options?.progress) yield* options.progress(metadata)
                    }),
                }).pipe(Effect.flatMap(output.truncate)),
              ).pipe(
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    if (exit._tag === "Success") {
                      yield* bus.publish(SessionEvent.Tool.Success, {
                        ...owner,
                        content: isReadonlyArrayNonEmpty(exit.value.content)
                          ? exit.value.content
                          : [{ type: "text", text: "(empty result)" }],
                        metadata: exit.value.metadata,
                        executed: false,
                      })
                      return
                    }
                    const failure = Cause.squash(exit.cause)
                    const cancelled =
                      Cause.hasInterrupts(exit.cause) ||
                      failure instanceof Permission.DeclinedError ||
                      failure instanceof QuestionTool.CancelledError
                    yield* bus.publish(SessionEvent.Tool.Failed, {
                      ...owner,
                      error: cancelled ? { type: "aborted", message: "Tool call cancelled" } : toSessionError(failure),
                      metadata: {
                        ...(yield* Ref.get(progress)),
                        ...(failure instanceof Tool.Error ? failure.metadata : undefined),
                      },
                      executed: false,
                    })
                  }),
                ),
              )
            }),
          )
        }),
      ),
    switchAgent: (agent: Agent.ID) =>
      inLocation(
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          if (!(yield* agents.get(agent))) return yield* Effect.fail(new Error(`Unknown agent: ${agent}`))
          yield* sessions.switchAgent({ sessionID: session.id, agent })
        }),
      ),
    changes: Stream.unwrap(inLocation(Effect.map(Tool.Service, (tools) => tools.changes))),
  }
})

export type Interface = Effect.Success<ReturnType<typeof open>>
