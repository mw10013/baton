import * as Domain from "@/lib/Domain";

/**
 * Runs `body` with `ShopLimits.maxOrdersPerCycle` lowered to `limit`, then
 * restores it, whatever `body` did.
 *
 * The real ceiling is more orders than a test should sync, so the ceiling
 * tests lower the constant for the duration — the same seam the open-run
 * ceiling tests use, and for the same reason: threading a limit through
 * `syncOrderWebhook` for nobody but a test would put a test seam in the
 * production signature. vitest-pool-workers runs each file in its own
 * isolate, so no other file sees the change.
 */
export const withMaxOrdersPerCycle = <A>(
  limit: number,
  body: () => Promise<A>,
) => {
  const limits = Domain.ShopLimits as { maxOrdersPerCycle: number };
  const original = limits.maxOrdersPerCycle;
  limits.maxOrdersPerCycle = limit;
  return body().finally(() => {
    limits.maxOrdersPerCycle = original;
  });
};
