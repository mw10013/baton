import type * as Domain from "@/lib/Domain";

/**
 * The strip's order, left to right: what the viewer has in hand, then what
 * they can pick up, then what a teammate is holding (so a person covering a
 * bench sees the half-done work), then what has stopped, then what can still
 * be undone. Mine leads because it is the tab the member lands on and the one
 * they return to; the flagged tab no longer has to lead to be seen, because
 * its count is in the strip whatever tab is open.
 *
 * Presentation only. Which tab a row is in, and how many of each the read
 * counts, are the object's (`Domain.tierOf`, `Domain.RunQuery`): one read
 * returns one tab's rows, so the page can no longer group rows it does not
 * hold.
 */
export const TABS = [
  "mine",
  "upNext",
  "inProgress",
  "attention",
  "done",
] as const satisfies readonly Domain.RunTab[];

/**
 * The `attention` tab holds every flag, but it reads **Blocked**: a held run
 * is what a member sees there nearly always, and the reconcile flags
 * (quantity changed, order cancelled, already shipped) name themselves in
 * their own banner heading inside the row. One accurate word beats a category
 * name that describes nothing the reader can act on.
 *
 * The `inProgress` tab reads **Teammates** for the opposite reason: "In
 * progress" is already the state line on the member's own rows (`In progress
 * · you`) and the active item badge, so as a tab word it would name the
 * wrong thing twice over. What the tab is for is who is holding the work, and
 * that is what it says. The tier key stays `inProgress` — the object groups,
 * the strip labels.
 *
 * `Done today` stays as it is even though the window is
 * `Domain.DONE_WINDOW_MS` rather than a calendar day: the tab's empty state
 * says "in the last day", which is where that precision belongs.
 */
export const TAB_LABEL: Record<Domain.RunTab, string> = {
  mine: "Mine",
  upNext: "Up next",
  inProgress: "Teammates",
  attention: "Blocked",
  done: "Done today",
};

/** What an empty tab says, and which tab it points at. */
export const TAB_EMPTY: Record<
  Domain.RunTab,
  { readonly text: string; readonly goTo: Domain.RunTab | null }
> = {
  mine: { text: "Nothing in hand.", goTo: "upNext" },
  upNext: { text: "Nothing to start.", goTo: null },
  inProgress: { text: "Nobody else has work.", goTo: null },
  attention: { text: "Nothing is blocked.", goTo: null },
  done: { text: "Nothing finished in the last day.", goTo: null },
};
