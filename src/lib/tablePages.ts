import { useLocation } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * Set on the entry a table's Next pushed. The entry before it is the
     * same table one page up, so that table's Previous can be the browser's
     * Back. Every screen pages at most one table, so the flag needs no key.
     */
    readonly nextPage?: true;
  }
}

/**
 * Whether the current history entry was pushed by a table's Next, for a
 * keyset table (the controls table's "a merchant table with more rows than
 * its page" row, `Control` in `Screen.ts`). A keyset cursor pages forward
 * only and the page before is not in the URL, so Previous is the browser's
 * Back when this is true, and page one otherwise, as on the workflows index.
 */
export const useNextPageEntry = () =>
  useLocation({ select: (location) => location.state.nextPage === true });
