import type * as Domain from "@/lib/Domain";

/**
 * The state row's order, left to right, answers who has the work: the member,
 * then someone else, then nobody (ready for anyone on the member's teams),
 * then a person holding it back (blocked), then nobody any more (done or
 * closed). The two Started states sit side by side so the phone's two-column
 * row (`.run-state-row`) pairs them. The member's own state leads because it is
 * the one the member lands on and returns to between tasks; Blocked does not
 * have to lead to be seen, because its count is in the state row whatever
 * value is chosen.
 *
 * Presentation only. Which state a row is in, and how many of each the read
 * counts, are the object's (`Domain.listStateOf`, `Domain.RunQuery`): one read
 * returns one state's rows, so the page can no longer group rows it does not
 * hold. What a state is here: {@link Domain.WorkflowsListState}.
 */
export const STATES = [
  "started_by_you",
  "started_by_others",
  "ready",
  "blocked",
  "done",
] as const satisfies readonly Domain.WorkflowsListState[];

/**
 * Four of the labels are the vocabulary's state words, so the list and the
 * member's workflow page say the same word for one fact: a row under Ready
 * opens on a task that reads Ready.
 *
 * `started_by_you` and `started_by_others` read **Started by you** and
 * **Started by others**: both hold started tasks and differ only in who
 * started them. "Teammates" was wrong for a task the merchant started, which
 * lands in `started_by_others` (`Domain.listStateOf`) and is nobody's teammate.
 *
 * `ready` reads **Ready**, the task state its rows are in
 * (`Domain.taskStateOf`): current, and nobody has it. "Up next" read as
 * later, which is the vocabulary's waiting, and those tasks are not listed.
 *
 * `blocked` reads **Blocked**: a block is the only thing it holds
 * (`Domain.WorkflowsListState`), and a Shopify change never lands here.
 *
 * `done` reads **Done or closed**, the two run- and task-state words
 * for what it holds (`Domain.RecentItem`): "Done" alone would be wrong for a
 * workflow Shopify closed, and a time word ("Recent") named the window and
 * not the contents. The window is `Domain.DONE_WINDOW_MS`; the empty state
 * says "in the last day", which is where that precision belongs.
 *
 * Each key is the label's words, so a URL reads as the screen does.
 */
export const STATE_LABEL: Record<Domain.WorkflowsListState, string> = {
  started_by_you: "Started by you",
  started_by_others: "Started by others",
  ready: "Ready",
  blocked: "Blocked",
  done: "Done or closed",
};

/** What an empty state says, and which state it points at. */
export const STATE_EMPTY: Record<
  Domain.WorkflowsListState,
  {
    readonly text: string;
    readonly goTo: Domain.WorkflowsListState | null;
  }
> = {
  started_by_you: { text: "Nothing started by you.", goTo: "ready" },
  started_by_others: { text: "Nothing started by others.", goTo: null },
  ready: { text: "Nothing is ready.", goTo: null },
  blocked: { text: "Nothing is blocked.", goTo: null },
  done: { text: "Nothing done or closed in the last day.", goTo: null },
};

/**
 * The start of a search's empty line, "Nothing matches <term>": one
 * sentence and a Clear search button, the controls table's rule for a
 * search with nothing matching (`Control` in `Screen.ts`).
 */
export const SEARCH_EMPTY = "Nothing matches";
