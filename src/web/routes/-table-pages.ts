import { useLocation } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * Set on the entry a table's Next pushed. The entry before it is the same table one page up,
     * so that table's Previous can be the browser's Back. Every screen pages at most one table,
     * so the flag needs no key.
     */
    readonly nextPage?: true;
    /**
     * Set on the entry a row of the workflows list pushes when it opens the member's workflow
     * page: the entry before this one is the list as the member left it, depth and scroll
     * included, so the page's Workflows link can be the browser's Back.
     */
    readonly fromWorkflowsList?: true;
  }
}

/**
 * Whether the current history entry was pushed by a table's Next, for a keyset table. A keyset
 * cursor pages forward only and the page before is not in the URL, so Previous is the browser's
 * Back when this is true, and page one otherwise.
 */
export const useNextPageEntry = () =>
  useLocation({ select: (location) => location.state.nextPage === true });

/** Whether the current history entry was pushed by a row of the workflows list. */
export const useFromWorkflowsList = () =>
  useLocation({ select: (location) => location.state.fromWorkflowsList === true });
