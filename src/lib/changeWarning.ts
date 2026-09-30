import type * as Domain from "@/lib/Domain";

import { formatNumber } from "@/lib/format";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

/**
 * The Change workflow modal's warning on a run that has work on it. Done
 * outranks started because it is the bigger loss: a done task is work
 * someone will have to do again under the new workflow, while a started one
 * is someone's work in hand. Tasks do not carry over — the new run is copied from
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

/** The Cancel workflow modal's heading: the question, naming the workflow and the item. */
export const cancelHeading = (workflow: Domain.WorkflowName, item: string) =>
  `Cancel ${workflow} on ${item}?`;

/**
 * The Cancel workflow modal's body. Cancel workflow closes the run
 * (`merchant_cancelled`, `Domain.ClosedReason`): work on it stops, the steps
 * already done stay on the run as the record, and nothing starts on the item
 * until the merchant chooses a workflow (`Domain.RunState`). There is no way
 * back, so this is the guard against a mistaken cancel. The heading
 * ({@link cancelHeading}) names what is cancelled, so the body does not.
 */
export const CANCEL_WARNING =
  "Work on it stops. Steps already done stay on record. You can attach another workflow to the item afterwards.";
