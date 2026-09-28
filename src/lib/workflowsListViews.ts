import type * as Domain from "@/lib/Domain";

/**
 * The view row's order, left to right, answers who has the work: the viewer,
 * then someone else, then nobody (ready for anyone on the viewer's teams),
 * then a person holding it back (blocked), then nobody any more (done or
 * closed). The two Started views sit side by side so the phone's two-column
 * row (`.run-view-row`) pairs them. The viewer's own view leads because it is
 * the one the member lands on and returns to between tasks; the Blocked view
 * does not have to lead to be seen, because its count is in the view row
 * whatever view is pressed.
 *
 * Presentation only. Which view a row is in, and how many of each the read
 * counts, are the object's (`Domain.tierOf`, `Domain.RunQuery`): one read
 * returns one view's rows, so the page can no longer group rows it does not
 * hold. What a view is: {@link Domain.WorkflowsListView}.
 */
export const VIEWS = [
  "mine",
  "teammates",
  "upNext",
  "blocked",
  "done",
] as const satisfies readonly Domain.WorkflowsListView[];

/**
 * Four of the labels are the glossary's state words, so the list and the
 * member's workflow page say the same word for one fact: a row under Ready
 * opens on a task that reads Ready.
 *
 * The `mine` and `teammates` views read **Started by you** and **Started by
 * others**: both hold started tasks and differ only in who started them.
 * "Teammates" was wrong for a task the merchant started, which lands in the
 * `teammates` tier (`Domain.tierOf`) and is nobody's teammate.
 *
 * The `upNext` view reads **Ready**, the task state its rows are in
 * (`Domain.taskStateOf`): current, and nobody has it. "Up next" read as
 * later, which is the glossary's waiting, and those tasks are not listed.
 *
 * The `blocked` view reads **Blocked**: a block is the only thing it holds
 * (`Domain.WorkflowsListView`), and a Shopify change never lands here.
 *
 * The `done` view reads **Done or closed**, the two run- and task-state words
 * for what it holds (`Domain.RecentItem`): "Done" alone would be wrong for a
 * workflow Shopify closed, and a time word ("Recent") named the window and
 * not the contents. The window is `Domain.DONE_WINDOW_MS`; the empty state
 * says "in the last day", which is where that precision belongs.
 *
 * The keys keep their old names; only the labels are the screen's.
 */
export const VIEW_LABEL: Record<Domain.WorkflowsListView, string> = {
  mine: "Started by you",
  teammates: "Started by others",
  upNext: "Ready",
  blocked: "Blocked",
  done: "Done or closed",
};

/** What an empty view says, and which view it points at. */
export const VIEW_EMPTY: Record<
  Domain.WorkflowsListView,
  { readonly text: string; readonly goTo: Domain.WorkflowsListView | null }
> = {
  mine: { text: "Nothing in hand.", goTo: "upNext" },
  teammates: { text: "Nobody else has work.", goTo: null },
  upNext: { text: "Nothing to start.", goTo: null },
  blocked: { text: "Nothing is blocked.", goTo: null },
  done: { text: "Nothing done or closed in the last day.", goTo: null },
};
