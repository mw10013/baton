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

export const runResultMessage = Match.typeTags<
  Domain.RunResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "This workflow no longer exists.",
  /* The page offers only what `Domain.runActions` and `Domain.taskActions`
     allow; a refusal is the work changing under the page (closed by Shopify
     or the merchant while it was open), or another team's task. */
  NotAllowed: () =>
    "This changed just now, or belongs to another team. Refresh.",
  /* Only the reason editor can reach this: somebody unblocked the run while
     it was open, so the edit has nothing to write on. */
  NotBlocked: () => "This workflow is no longer blocked.",
  /* Also a Put back on a task whose Put back or Done by someone else landed just now. */
  NotReady: () =>
    "This task or an earlier one changed just now, or this task is waiting on another team. Refresh.",
  /* A done run, or one Shopify or the merchant closed under the page. */
  Terminal: () => "This workflow is already done or closed.",
  /* The page hides Start and Done behind the block; a block that landed
     after the render is the only way here. */
  Blocked: () => "This workflow was blocked just now. Unblock it first.",
  ReopenBlocked: ({ taskName, teamName }) =>
    `${teamName} already started ${taskName}. Ask them.`,
});

/**
 * The member mutations, shared by the workflows list and the workflow page so the two
 * cannot drift on how a click reaches the object or how its answer reads.
 *
 * Every action is a `@callable()` on the member socket, reached through
 * `withSocketRecovery` so a zombie connection is healed rather than waited
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
 * Invalidating here paints their own action immediately; the push still
 * covers everyone else.
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
  const setBlockReason = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      call((stub) =>
        stub.memberSetBlockReason({ runId, reason: textOrNull(reason) }),
      ).then(settle),
  });
  const unblock = useMutation({
    mutationFn: (runId: string) =>
      call((stub) => stub.memberUnblockRun({ runId })).then(settle),
  });
  const mutations = [
    start,
    markDone,
    reopen,
    putBack,
    note,
    block,
    setBlockReason,
    unblock,
  ];
  /**
   * Disabled while a write is in flight, and while the socket is not
   * identified: these actions have no other transport, so offering them
   * before the handshake would only queue a click that cannot be sent.
   * `SocketBanner` explains the second case after its own grace period.
   */
  const pending =
    mutations.some((mutation) => mutation.isPending) || !identified;
  /**
   * The refusal the page shows, from the one-tap actions only. The three
   * text writes (note, block, reason) go through a modal that keeps its own
   * refusal under the field the person is looking at; feeding them here too
   * would print the same sentence twice, once behind the modal and again
   * after it closes, until the next write cleared it.
   */
  const bannerMutations = [start, markDone, reopen, putBack, unblock];
  const banner =
    bannerMutations.find((mutation) => mutation.error)?.error?.message ??
    bannerMutations
      .map((mutation) => mutation.data && runResultMessage(mutation.data))
      .find((message) => typeof message === "string") ??
    null;
  return {
    start,
    markDone,
    reopen,
    putBack,
    note,
    block,
    setBlockReason,
    unblock,
    pending,
    banner,
  };
};
