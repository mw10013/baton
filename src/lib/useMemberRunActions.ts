import type * as Domain from "@/lib/Domain";
import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { Match } from "effect";

import { withSocketRecovery } from "@/lib/ShopAgentContext";

/** A blank text field on the wire is "cleared", which the object stores as `null`. */
export const textOrNull = (value: string) =>
  value.trim().length === 0 ? null : value;

const CONNECTING = "Still connecting. Try again in a moment.";

/** A rejected write's message, for a modal that shows it under its own field rather than in {@link useMemberRunActions}'s `banner`. */
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn't save. Try again.";

/**
 * A refused write's fact, in the present tense (`CopySlot` in `Screen.ts`):
 * a modal shows it alone under its field, and {@link useMemberRunActions}'s
 * `banner` adds the effect on the page, as the `banner` slot's form asks.
 * `NotAllowed` is a race between the render and the click, or another
 * team's task ({@link Domain.RunResult}), and the page re-reads either way,
 * so the fact names what changed: the task for a task verb, the workflow
 * for a run verb.
 */
export const runResultMessage = (
  result: Domain.RunResult,
  subject: "task" | "workflow",
) =>
  Match.value(result).pipe(
    Match.tagsExhaustive({
      Ok: () => null,
      NotFound: () => "This workflow no longer exists",
      NotAllowed: () => `The ${subject} changed on another screen`,
    }),
  );

/**
 * The member mutations, shared by the workflows list and the workflow page so the two
 * cannot drift on how a click reaches the object or how its answer reads.
 *
 * Every action is a `@callable()` on the member socket, reached through
 * `withSocketRecovery` so a stale socket is healed rather than waited
 * out (`ShopAgentContext.tsx` describes both recovery layers). `identified`
 * gates them: the socket is the only path these mutations have, so a click
 * before the handshake has nothing to send on and says so rather than
 * failing opaquely.
 *
 * The inputs carry no identity. `memberId`, `memberEmail`, and `teamIds` live
 * on the connection the Worker's gate authorized, so the browser sends only
 * the id of the task or run it clicked and the text that was typed — see
 * `Domain.ConnectionState`.
 *
 * `onSuccess` is the page's own refetch. The write's publish would refetch
 * eventually, but the throttle in `useSubscribedQuery` means "eventually" is
 * up to two seconds — too long for the person who just pressed the button.
 * Invalidating here paints their own action immediately; the publish still
 * reaches everyone else.
 */
export const useMemberRunActions = ({
  agent,
  identified,
  onSuccess,
}: {
  readonly agent: ShopAgentSocket | null;
  readonly identified: boolean;
  readonly onSuccess: () => Promise<unknown>;
}) => {
  const call = React.useCallback(
    <A>(run: (stub: ShopAgentSocket["stub"]) => Promise<A>) =>
      agent && identified
        ? withSocketRecovery(agent)(() => run(agent.stub))
        : Promise.reject(new Error(CONNECTING)),
    [agent, identified],
  );
  const settle = async (result: Domain.RunResult) => {
    await onSuccess();
    return result;
  };
  const start = useMutation({
    mutationFn: (runTaskId: string) =>
      call((stub) => stub.memberStartTask({ runTaskId })).then(settle),
  });
  const markDone = useMutation({
    mutationFn: (runTaskId: string) =>
      call((stub) => stub.memberMarkTaskDone({ runTaskId })).then(settle),
  });
  const reopen = useMutation({
    mutationFn: (runTaskId: string) =>
      call((stub) => stub.memberReopenTask({ runTaskId })).then(settle),
  });
  const putBack = useMutation({
    mutationFn: (runTaskId: string) =>
      call((stub) => stub.memberPutBackTask({ runTaskId })).then(settle),
  });
  const note = useMutation({
    mutationFn: ({ runId, note }: { runId: string; note: string }) =>
      call((stub) =>
        stub.memberSetRunNote({ runId, note: textOrNull(note) }),
      ).then(settle),
  });
  const block = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      call((stub) =>
        stub.memberBlockRun({ runId, reason: textOrNull(reason) }),
      ).then(settle),
  });
  const unblock = useMutation({
    mutationFn: (runId: string) =>
      call((stub) => stub.memberUnblockRun({ runId })).then(settle),
  });
  const mutations = [start, markDone, reopen, putBack, note, block, unblock];
  /**
   * Disabled while a write is in flight, and while the socket is not
   * identified: these actions have no other transport, so offering them
   * before the handshake would only queue a click that cannot be sent.
   * `SocketBanner` explains the second case after its own grace period.
   */
  const pending =
    mutations.some((mutation) => mutation.isPending) || !identified;
  /**
   * The refusal the page shows, from the one-tap actions only. The two
   * text writes (note, block) go through a modal that keeps its own
   * refusal under the field the person is looking at; feeding them here too
   * would print the same sentence twice, once behind the modal and again
   * after it closes, until the next write cleared it.
   */
  const bannerMutations = [
    { mutation: start, subject: "task" },
    { mutation: markDone, subject: "task" },
    { mutation: reopen, subject: "task" },
    { mutation: putBack, subject: "task" },
    { mutation: unblock, subject: "workflow" },
  ] as const;
  const banner =
    bannerMutations.find(({ mutation }) => mutation.error)?.mutation.error
      ?.message ??
    bannerMutations
      .map(
        ({ mutation, subject }) =>
          mutation.data && runResultMessage(mutation.data, subject),
      )
      .map((fact) =>
        typeof fact === "string"
          ? `${fact}. This page shows it as it is now.`
          : fact,
      )
      .find((message) => typeof message === "string") ??
    null;
  return {
    start,
    markDone,
    reopen,
    putBack,
    note,
    block,
    unblock,
    pending,
    banner,
  };
};
