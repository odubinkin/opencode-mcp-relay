export * as SessionToolExecution from "./tool-execution.js"

import { Cause, Effect, Result } from "effect"
import { Permission } from "../permission.js"
import { QuestionTool } from "../tool/plugin/question.js"
import type { Tool } from "../tool.js"

export type Error = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

/** Recover the deliberate decline tunnel at either internal or external execution boundaries. */
export function execute(snapshot: Tool.Snapshot, input: Parameters<Tool.Snapshot["execute"]>[0]) {
  return snapshot.execute(input).pipe(
    Effect.catchCauseFilter((cause) => {
      const decline = cause.reasons
        .map((reason) =>
          Cause.isDieReason(reason) ? reason.defect : Cause.isFailReason(reason) ? reason.error.error : undefined,
        )
        .find(
          (value): value is Permission.DeclinedError | QuestionTool.CancelledError =>
            value instanceof Permission.DeclinedError || value instanceof QuestionTool.CancelledError,
        )
      return decline ? Result.succeed(decline) : Result.fail(cause)
    }, Effect.fail),
  )
}
