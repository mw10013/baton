import { useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Atom from "effect/reactivity/Atom";
import { useState } from "react";
import type { BlockReason, RunNote, RunResult } from "../../domain/shop-work.ts";
import { connectionStateAtom } from "../client/actor-connection.ts";
import {
  memberBlockRunAtom,
  memberMarkTaskDoneAtom,
  memberPutBackTaskAtom,
  memberReopenTaskAtom,
  memberSetRunNoteAtom,
  memberStartTaskAtom,
  memberUnblockRunAtom,
} from "../client/shop-actor-client.ts";
import { thrownCopy } from "./form.ts";
import { useKeyedPresses } from "./press-waiting.ts";

/**
 * A refused write's fact, in the present tense: a modal shows it alone under its field, and
 * {@link useMemberRunActions}' `banner` adds the effect on the page. `NotAllowed` is a race
 * between the render and the click, or another team's task (`RunResult`), and the page re-reads
 * either way, so the fact names what changed: the task for a task verb, the workflow for a run
 * verb. The member's own words: the merchant's order page says `NotFound` its own way.
 */
export const runResultMessage = (result: RunResult, subject: "task" | "workflow") =>
  Match.value(result).pipe(
    Match.tagsExhaustive({
      Ok: () => null,
      NotFound: () => "This workflow no longer exists",
      NotAllowed: () => `The ${subject} changed on another screen`,
    }),
  );

/** A press that failed with no typed answer (a lost socket, a defect), under a field or in the banner. */
export const errorMessage = (cause: Cause.Cause<unknown>) =>
  thrownCopy(Cause.squash(cause), "Couldn't save. Try again.");

/** What the socket reads as before hydration: not open, so nothing presses. */
const notOpen = Atom.make("connecting" as const);

/**
 * The member's run writes, shared by the workflows list and the member's workflow page, so the
 * two cannot drift on how a press reaches the actor or how its answer reads. Every write is a
 * socket procedure, one atom per task or run ({@link useKeyedPresses}), and carries no identity:
 * the gate put the member and their teams on the socket, so the browser sends only the id it
 * pressed and the text that was typed. The write's notice repaints every screen that reads the
 * run, this one included.
 *
 * `pending` is true while a press is in flight, before hydration, and while the socket is not
 * open: these writes have no other transport, so offering them before the socket opens would only
 * queue a press the member cannot see land. The socket banner explains a socket that stays down.
 *
 * `banner` is the refusal the page shows, from the one-press writes only ({@link runResultMessage}
 * and the effect). The two text writes (note, block) go through a modal that keeps its own
 * refusal under its field and answers it from `note` and `block`; feeding them here too would
 * print the same sentence twice.
 */
export const useMemberRunActions = () => {
  const presses = useKeyedPresses();
  const open = useAtomValue(useHydrated() ? connectionStateAtom : notOpen) === "open";
  const [banner, setBanner] = useState<string | null>(null);
  const onePress =
    (subject: "task" | "workflow") =>
    async (exit: Promise<Exit.Exit<RunResult, unknown>>): Promise<void> => {
      setBanner(null);
      setBanner(
        Exit.match(await exit, {
          onSuccess: (result) => {
            const fact = runResultMessage(result, subject);
            return fact === null ? null : `${fact}. This page shows it as it is now.`;
          },
          onFailure: errorMessage,
        }),
      );
    };
  const inModal = async (exit: Promise<Exit.Exit<RunResult, unknown>>) =>
    Exit.match(await exit, {
      onSuccess: (result) => runResultMessage(result, "workflow"),
      onFailure: errorMessage,
    });
  return {
    pending: presses.busy || !open,
    banner,
    start: (runTaskId: string) =>
      onePress("task")(presses.press(memberStartTaskAtom(runTaskId), { runTaskId })),
    markDone: (runTaskId: string) =>
      onePress("task")(presses.press(memberMarkTaskDoneAtom(runTaskId), { runTaskId })),
    reopen: (runTaskId: string) =>
      onePress("task")(presses.press(memberReopenTaskAtom(runTaskId), { runTaskId })),
    putBack: (runTaskId: string) =>
      onePress("task")(presses.press(memberPutBackTaskAtom(runTaskId), { runTaskId })),
    unblock: (runId: string) =>
      onePress("workflow")(presses.press(memberUnblockRunAtom(runId), { runId })),
    /** Resolves `null` when the note landed, or the message for the modal's field. */
    note: (runId: string, note: RunNote | null) =>
      inModal(presses.press(memberSetRunNoteAtom(runId), { runId, note })),
    /** Resolves `null` when the block landed, or the message for the modal's field. */
    block: (runId: string, reason: BlockReason | null) =>
      inModal(presses.press(memberBlockRunAtom(runId), { runId, reason })),
  };
};
