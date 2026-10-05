import { useLocation } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * The search key whose Next pushed this entry (`after` on the teams and
     * members indexes, `membersAfter` and `workflowsAfter` on the team page,
     * `teamsAfter` on the member page). The entry before it is the same table
     * one page up, so that table's Previous can be the browser's Back. Named
     * by key because the team page pages two tables, and a Back past the
     * other table's Next would move the wrong one.
     */
    readonly nextPageOf?: string;
  }
}

/**
 * Whether the current history entry was pushed by `key`'s Next, for a
 * keyset table (the controls table's "a merchant table with more rows than
 * its page" row, `Control` in `Screen.ts`). A keyset cursor pages forward
 * only and the page before is not in the URL, so Previous is the browser's
 * Back when this is true, and page one otherwise, as on the workflows index.
 */
export const useNextPageEntry = (key: string) =>
  useLocation({ select: (location) => location.state.nextPageOf === key });
