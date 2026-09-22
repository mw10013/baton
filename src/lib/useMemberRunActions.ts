import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { Match } from "effect";

import * as Domain from "@/lib/Domain";
import { withSocketRecovery } from "@/lib/ShopAgentContext";

/** A blank text field on the wire is "cleared", which the object stores as `null`. */
export const textOrNull = (value: string) =>
  value.trim().length === 0 ? null : value;

const CONNECTING = "Still connecting. Try again in a moment.";

export const runResultMessage = Match.typeTags<
  Domain.RunResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That work no longer exists.",
  NotAllowed: () => "This step belongs to another team.",
  /* Only the reason editor can reach this: somebody unblocked the run while
     it was open, so the edit has nothing to write on. */
  NotBlocked: () => "This work is no longer blocked.",
  /* Also a Put back on a step someone else put back or finished just now. */
  NotReady: () =>
    "This step or an earlier one changed just now, or this step is waiting on another team. Refresh.",
  Terminal: () => "This workflow is already finished or cancelled.",
  /* The page hides Start and Done behind the flag; a flag that landed after
     the render is the only way here. */
  Flagged: ({ flag }) =>
    Domain.flagIsReconcile(flag)
      ? "This work was flagged just now. Read the flag and dismiss it first."
      : "This work was blocked just now. Unblock it first.",
  UndoBlocked: ({ stepName, teamName }) =>
    `${teamName} already started ${stepName}. Ask them.`,
  /* Un-cancel is a merchant action and no member surface offers it; the
     variant is here because the union is one union, and a member reading a
     stale result should still get a sentence rather than nothing. */
  ItemHasRun: ({ workflowName }) => `This item is already on ${workflowName}.`,
});

/**
 * The member mutations, shared by the run list and the work page so the two
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
 * the id of the step or run it clicked and the text that was typed — see
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
    mutationFn: (runStepId: string) =>
      call((stub) => stub.startStep({ runStepId })).then(settle),
  });
  const complete = useMutation({
    mutationFn: (runStepId: string) =>
      call((stub) => stub.completeStep({ runStepId })).then(settle),
  });
  const uncomplete = useMutation({
    mutationFn: (runStepId: string) =>
      call((stub) => stub.uncompleteStep({ runStepId })).then(settle),
  });
  const unstart = useMutation({
    mutationFn: (runStepId: string) =>
      call((stub) => stub.unstartStep({ runStepId })).then(settle),
  });
  const note = useMutation({
    mutationFn: ({ runStepId, note }: { runStepId: string; note: string }) =>
      call((stub) =>
        stub.setStepNote({ runStepId, note: textOrNull(note) }),
      ).then(settle),
  });
  const block = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      call((stub) => stub.blockRun({ runId, reason: textOrNull(reason) })).then(
        settle,
      ),
  });
  const setBlockReason = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      call((stub) =>
        stub.setBlockReason({ runId, reason: textOrNull(reason) }),
      ).then(settle),
  });
  const dismiss = useMutation({
    mutationFn: (runId: string) =>
      call((stub) => stub.dismissFlag({ runId })).then(settle),
  });
  const mutations = [
    start,
    complete,
    uncomplete,
    unstart,
    note,
    block,
    setBlockReason,
    dismiss,
  ];
  /**
   * Disabled while a write is in flight, and while the socket is not
   * identified: these actions have no other transport, so offering them
   * before the handshake would only queue a click that cannot be sent.
   * `SocketBanner` explains the second case after its own grace period.
   */
  const pending =
    mutations.some((mutation) => mutation.isPending) || !identified;
  const banner =
    mutations.find((mutation) => mutation.error)?.error?.message ??
    mutations
      .map((mutation) => mutation.data && runResultMessage(mutation.data))
      .find((message) => typeof message === "string") ??
    null;
  return {
    start,
    complete,
    uncomplete,
    unstart,
    note,
    block,
    setBlockReason,
    dismiss,
    pending,
    banner,
  };
};
