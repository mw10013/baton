import type * as Domain from "@/lib/Domain";

import { formatNumber } from "@/lib/format";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

/**
 * The Change workflow modal's warning on a run that has work on it. Done
 * outranks started because it is the bigger loss: a finished task is work
 * someone will have to do again under the new workflow, while a started one
 * is work in progress. Tasks do not carry over — the new run is copied from
 * its own definition — so the sentence says so rather than leaving the
 * merchant to assume otherwise.
 *
 * The note does not carry over either: it is a column on the run, and the
 * replacement run is inserted without one (`RunRepository.insertRun`).
 * When the old run has a note the last sentence names it, so the merchant
 * hears it before pressing Change rather than finding a blank note after.
 *
 * Counts steps, not task rows: a step is done when every task of it is and
 * started when any task of it is, and the total is the run's last step. The
 * merchant reads "task" only where a step holds more than one
 * ({@link Domain.WorkflowTask}), so a row count would name a noun a linear
 * shop never sees.
 */
export const changeWarning = (
  from: Domain.WorkflowName,
  to: string,
  tasks: readonly Domain.RunTask[],
  hasNote: boolean,
) => {
  const steps = WorkflowLayout.stepsOf(tasks);
  const done = steps.filter((step) =>
    step.every((task) => task.doneAt !== null),
  ).length;
  const started = steps.filter((step) =>
    step.some((task) => task.startedAt !== null),
  ).length;
  const total = formatNumber(steps.length);
  const progress =
    done > 0
      ? `${formatNumber(done)} of ${total} steps done`
      : `${formatNumber(started)} of ${total} steps started`;
  const lost = hasNote ? "That work and the note" : "That work";
  return `${from} has ${progress}. Change to ${to} anyway? ${lost} will not carry over.`;
};

/**
 * The Cancel run modal's body. Cancel run closes the run
 * (`merchant_cancelled`, `Domain.ClosedReason`): work on it stops, the steps
 * already done stay on the run as the record, and nothing starts on the item
 * until the merchant chooses a workflow (`Domain.RunStatus`). There is no way
 * back, so this is the guard against a mistaken cancel.
 */
export const cancelWarning = (workflow: Domain.WorkflowName, item: string) =>
  `Cancel the ${workflow} run on ${item}? Work on it stops. Steps already done stay on record. You can start another workflow on the item afterwards.`;
