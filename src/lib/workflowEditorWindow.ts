import "@/lib/shopifyAppBridgeElements";
import * as React from "react";

/**
 * The workflow editor runs inside an App Bridge `s-app-window`, a full-screen
 * iframe the admin opens over the page that launched it (the same chrome
 * Shopify Flow uses for its editor: sidebar hidden, the app's `s-page` heading
 * and actions hoisted into an admin-owned bar with an X). The window's
 * document is our origin but a sibling of the app's own iframe, not its
 * child: `window.parent` is the admin, so the editor cannot reach the page
 * that opened it through the DOM. A same-origin `BroadcastChannel` is the one
 * channel that needs no host cooperation, so the editor announces outcomes on
 * it and the opener decides what to do with the window (hide it, refetch,
 * navigate).
 *
 * The editor knows it is in a window from the `chrome=window` search flag the
 * opener puts on `src`; the same route still works as a plain page without
 * it. The flag is a word rather than `1` because the router's search parser
 * JSON-decodes values and would hand a number back.
 */
const CHANNEL = "baton-workflow-editor";

const EDITOR_WINDOW_ID = "workflow-editor-window";

export interface EditorWindowMessage {
  readonly type: "applied" | "deleted";
  readonly workflowId: string;
}

export const postEditorWindowMessage = (message: EditorWindowMessage): void => {
  const channel = new BroadcastChannel(CHANNEL);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no origin
  channel.postMessage(message);
  channel.close();
};

const editorSrc = (workflowId: string, search = ""): string =>
  `/app/workflows/${workflowId}/edit?chrome=window${search}`;

/**
 * Owns one `s-app-window` for the workflow editor on the calling page:
 * spread `windowProps` onto the element and point buttons at
 * `windowProps.id` with `command="--show"`, or call `open`.
 *
 * `open` sets `src` and shows the window; `src` is reset to the standing
 * value on hide so a later `--show` from a plain Edit button does not reopen
 * with a `tag=edit` deep link a previous Edit tag click left behind.
 * Whatever hides the window — the admin X, Escape, or an Apply inside — fires
 * `onHide`, so the page refetches: the editor writes straight to the draft
 * and the page must not keep showing a stale Draft tab.
 *
 * An `applied` message from inside hides the window; `deleted` hides it and
 * hands the id to `onDeleted` because the page that opened it no longer has
 * anything to show for that workflow.
 */
export const useWorkflowEditorWindow = ({
  workflowId,
  onHide,
  onDeleted,
}: {
  /** The workflow the standing `src` points at; the list page has none until create. */
  readonly workflowId?: string;
  readonly onHide: () => void;
  readonly onDeleted: (workflowId: string) => void;
}): {
  readonly windowProps: {
    readonly ref: React.RefObject<SAppWindowElement | null>;
    readonly id: string;
    readonly src: string;
  };
  readonly open: (workflowId: string, search?: string) => void;
} => {
  const ref = React.useRef<SAppWindowElement | null>(null);
  /**
   * The standing `src` must be a real app URL with a query string even when
   * there is no workflow yet: with `about:blank` App Bridge rewrote a later
   * `src` assignment to `…/edit&chrome=window`, dropping the `?` (seen live
   * 2026-09-12), and the editor then loaded without the window flag.
   */
  const src = editorSrc(workflowId ?? "new");
  const callbacks = React.useRef({ onHide, onDeleted });
  React.useEffect(() => {
    callbacks.current = { onHide, onDeleted };
  });
  /** Which workflow the window is showing right now; `open` may point it away from `workflowId`. */
  const shown = React.useRef<string | undefined>(workflowId);
  /**
   * Set while a `deleted` message is closing the window so the `hide` event
   * does not also run `onHide`: the list page's `onHide` navigates to the
   * workflow it just created, which after a delete no longer exists.
   */
  const deleting = React.useRef(false);

  React.useEffect(() => {
    const element = ref.current;
    const onHideEvent = () => {
      if (element) element.src = src;
      shown.current = workflowId;
      if (!deleting.current) callbacks.current.onHide();
    };
    element?.addEventListener("hide", onHideEvent);
    return () => {
      element?.removeEventListener("hide", onHideEvent);
    };
  }, [src, workflowId]);

  React.useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    const listener = (event: MessageEvent<EditorWindowMessage>) => {
      const message = event.data;
      if (message.workflowId !== shown.current) return;
      const element = ref.current;
      if (message.type === "applied") void element?.hide();
      if (message.type === "deleted") {
        deleting.current = true;
        void element?.hide().then(() => {
          deleting.current = false;
          callbacks.current.onDeleted(message.workflowId);
        });
      }
    };
    channel.addEventListener("message", listener);
    return () => {
      channel.removeEventListener("message", listener);
      channel.close();
    };
  }, []);

  const open = (id: string, search = "") => {
    const element = ref.current;
    if (!element) return;
    shown.current = id;
    element.src = editorSrc(id, search);
    void element.show();
  };

  return { windowProps: { ref, id: EDITOR_WINDOW_ID, src }, open };
};
