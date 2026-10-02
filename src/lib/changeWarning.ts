import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

/**
 * The Change workflow modal's warning, the `confirm` slot of the controls
 * row "a verb that replaces a run with a record on it" on `Control`
 * (`src/lib/Screen.ts`): empty on a run with no record
 * ({@link Domain.runHasRecord}), since a change there loses nothing, so the
 * page calls it unconditionally and the gate lives here. Done outranks started because it is the bigger
 * loss: a done task is work someone will have to do again under the new
 * workflow, while a started one is someone's work in hand. Tasks do not
 * carry over — the new run is copied from its own definition — so the
 * sentence says so rather than leaving the merchant to assume otherwise.
 *
 * The block and the note do not carry over either: they are columns on the
 * run, and the replacement run is inserted without them
 * (`RunRepository.insertRun`). The last sentence names whichever the old
 * run has, so the merchant hears it before pressing Change rather than
 * finding the hold lifted or the note blank after. With nothing started or
 * done the progress clause is dropped and the first sentence says what the
 * run does have. The shapes:
 *
 * - "Engraving has 1 of 2 steps done. Change to Rush anyway? That work, the
 *   block and the note will not carry over."
 * - "Engraving is blocked. Change to Rush anyway? The block will not carry
 *   over."
 * - "Engraving has a note. Change to Rush anyway? The note will not carry
 *   over."
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
  run: Pick<Domain.Run, "blockedAt" | "note">,
  tasks: readonly Domain.RunTask[],
) => {
  if (!Domain.runHasRecord(run, tasks)) return "";
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
  const worked = !Domain.runIsUnstarted(tasks);
  const blocked = Domain.runIsBlocked(run);
  const lead = (() => {
    if (worked) return `${from} has ${progress}.`;
    if (blocked) return `${from} is blocked.`;
    return `${from} has a note.`;
  })();
  const lost = [
    ...(worked ? ["that work"] : []),
    ...(blocked ? ["the block"] : []),
    ...(Domain.runHasNote(run) ? ["the note"] : []),
  ];
  const listed =
    lost.length > 1
      ? `${lost.slice(0, -1).join(", ")} and ${lost.at(-1) ?? ""}`
      : lost.join("");
  return `${lead} Change to ${to} anyway? ${listed.charAt(0).toUpperCase()}${listed.slice(1)} will not carry over.`;
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
