import * as React from "react";

/**
 * Suppresses Polaris's misfiring backdrop dismissal on `s-modal`.
 *
 * Polaris detects an outside click with `event.target === <dialog>` — its
 * `Symbol("onBackdropClick")` handler, bound to the shadow-root `<dialog>`
 * alongside the Escape handler. Browsers set a `click`'s target to the nearest
 * common ancestor of the `mousedown` and `mouseup` targets, and in the flat tree
 * the modal's slotted content sits inside that dialog. So any gesture pressing
 * inside the modal and releasing on the backdrop — drag-selecting a field past
 * its edge, a sloppy click, a scrollbar drag — synthesizes a click targeting the
 * dialog, which Polaris reads as a deliberate dismissal and hides the modal.
 * Reproduced against the CDN runtime with no React or App Bridge involved; also
 * reported at
 * https://community.shopify.dev/t/a-modal-s-modal-disappears-on-mouse-up-event/33154
 * See https://developer.mozilla.org/en-US/docs/Web/API/Element/click_event for
 * the ancestor rule.
 *
 * The dialog is inside the `s-modal` shadow root, so a capture listener on the
 * host runs before Polaris's own listener and can stop the event there. Only
 * clicks already targeting the dialog are stopped, so controls inside the modal
 * are never blocked and a genuine backdrop-to-backdrop click still dismisses.
 *
 * `composedPath()[0]` rather than `event.target` is what identifies a real
 * backdrop hit: retargeting reports the host for every shadow-internal target,
 * while the backdrop and the synthesized cross-boundary click both report the
 * dialog. The dialog is resolved per event because Polaris renders it
 * asynchronously and re-queries it through a `MutationObserver`.
 *
 * The guard's reach ends at the iframe edge: a drag that releases on the
 * admin host's own overlay is dismissed host-side via App Bridge, with no
 * click ever reaching this document (see `setModalDirty`).
 */
export const useModalBackdropDismissGuard = (modalId: string): void => {
  React.useEffect(() => {
    const modal = document.querySelector<HTMLElement>(`#${modalId}`);
    const isBackdrop = (event: Event) =>
      event.composedPath()[0] === modal?.shadowRoot?.querySelector("dialog");
    let startedOnBackdrop = false;
    const onPointerDown = (event: PointerEvent) => {
      startedOnBackdrop = isBackdrop(event);
    };
    const onClick = (event: MouseEvent) => {
      if (!startedOnBackdrop && isBackdrop(event)) event.stopPropagation();
    };
    modal?.addEventListener("pointerdown", onPointerDown, true);
    modal?.addEventListener("click", onClick, true);
    return () => {
      modal?.removeEventListener("pointerdown", onPointerDown, true);
      modal?.removeEventListener("click", onClick, true);
    };
  }, [modalId]);
};

/**
 * Marks an `s-modal` as holding unsaved edits so Polaris refuses to dismiss it.
 *
 * Polaris's `hideOverlay` feature-detects an undocumented `dirty` property
 * before hiding: when truthy it dispatches a `shake-attempt` event and keeps
 * the dialog open, which blocks the backdrop click, Escape, and the header
 * close button in one place — including the synthesized cross-boundary click
 * that `useModalBackdropDismissGuard` exists for. Verified against the CDN
 * runtime (2026-08-25): all three dismissals are refused while `dirty` is
 * truthy and work again once it is cleared. Base `s-modal` wires no shake
 * animation, so a refused dismissal is invisible unless the caller listens
 * for `shake-attempt` and surfaces its own feedback.
 *
 * The key is deleted rather than set to `false` when clean because the footer
 * renderer detects support with `"dirty" in element` and renders an "Unsaved
 * changes" indicator whose hidden-state class is unstyled in the base
 * `s-modal` sheet — once the key exists the label shows even with no edits.
 * While actually dirty the indicator is accurate, so it is left to render.
 *
 * Programmatic hides (`command="--hide"`, `shopify.modal.hide`) go through
 * the same check, so a discarding button must clear dirtiness before the
 * check runs — and bubble-phase ordering is NOT enough. `hideOverlay` defers
 * its check by one microtask, and for a native click the browser runs a
 * microtask checkpoint between listener invocations, so a check queued by
 * Polaris's shadow-internal listener executes before React's root-delegated
 * `onClick` (observed live: a spurious refusal toast on Cancel, then App
 * Bridge's host retry closing the modal ~25ms later). Clear from a
 * capture-phase handler (`onClickCapture`) instead — it runs at the React
 * root before Polaris's listeners dispatch the command. Synthetic
 * `element.click()` keeps the stack full with no checkpoint between
 * listeners, which is why tests driven that way cannot see this race.
 *
 * The check is also not airtight: in the embedded admin the host dims the
 * whole admin around the iframe, and a pointer RELEASE on that host overlay —
 * a bare click there, or a drag that starts inside the iframe and releases
 * past its edge — makes the host send a dismiss over App Bridge's
 * MessagePort; Polaris's `onDismiss` then closes the `<dialog>` directly
 * even when this check refuses (stack-traced live 2026-08-25). The host page
 * never saw the press, so it cannot apply the started-inside test the
 * backdrop guard uses. Unreachable from app code without fighting App Bridge
 * across the postMessage boundary — deliberately not fought. And `dirty` is
 * an internal of the auto-updating CDN runtime, not a documented API.
 * Callers must keep an unexpected-close fallback rather than assuming a
 * dirty modal can never close.
 */
export const setModalDirty = (modalId: string, dirty: boolean): void => {
  const modal = document.querySelector<HTMLElement & { dirty?: boolean }>(
    `#${modalId}`,
  );
  if (!modal) return;
  if (dirty) modal.dirty = true;
  else if ("dirty" in modal) delete modal.dirty;
};
