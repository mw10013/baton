/** How long the click waits for `prepareManagePlan` before opening the pricing page anyway. */
export const PREPARE_MANAGE_PLAN_WAIT_MS = 1500;

/**
 * The Manage plan control on the home page's **Your plan**. A press runs `prepare` (the
 * `prepareManagePlan` server function: the plan's cache deadline shortened, the usage queue
 * sent), then opens the pricing page (`url`, the route context's `managePlanUrl`) in the top
 * frame, exactly once: when `prepare` answers, when it fails, or after
 * {@link PREPARE_MANAGE_PLAN_WAIT_MS}, whichever comes first.
 *
 * The call is awaited before the navigation so the write lands while the tab is still ours, and
 * a failure still opens the page: the cache deadline is a latency optimisation, never a gate on
 * a merchant's ability to reach their own billing. A lost session token can stall the request
 * past any patience, hence the bound. The failure is logged by the Backend, so nothing is
 * swallowed silently.
 */
export function ManagePlanButton({
  url,
  prepare,
  open = (href) => window.open(href, "_top"),
}: {
  readonly url: string;
  readonly prepare: () => Promise<unknown>;
  /** How the page is opened; the top frame by default. */
  readonly open?: (href: string) => void;
}) {
  return (
    <s-button
      variant="secondary"
      onClick={() => {
        let opened = false;
        const openOnce = () => {
          if (opened) return;
          opened = true;
          open(url);
        };
        const timer = setTimeout(openOnce, PREPARE_MANAGE_PLAN_WAIT_MS);
        void prepare()
          .then(openOnce, openOnce)
          .finally(() => {
            clearTimeout(timer);
          });
      }}
    >
      Manage plan
    </s-button>
  );
}
