import type * as Domain from "@/lib/Domain";

/**
 * The queue's order of presentation, top to bottom. The flagged tier first
 * because a flagged row is the one thing on the page that cannot wait; then
 * what the viewer themselves has in hand; then what a teammate has in hand (so
 * a person covering a bench sees the half-done work); then everything
 * untouched.
 *
 * The `attention` tier holds every flag, but its heading reads **Blocked**: a
 * held run is what a member sees there nearly always, and the reconcile flags
 * (quantity changed, order cancelled, already shipped) name themselves in
 * their own banner heading inside the row. One accurate word beats a
 * category name that describes nothing the reader can act on.
 *
 * Presentation only. Which tier a row is in, and how many of each the read
 * returns, are the object's (`Domain.tierOf`, `Domain.QueueLimits`): the read
 * is capped per tier, so the page can no longer group rows it does not hold.
 */
export const TIERS = [
  "attention",
  "mine",
  "inProgress",
  "upNext",
] as const satisfies readonly Domain.QueueTier[];
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  attention: "Blocked",
  mine: "Mine",
  inProgress: "In progress",
  upNext: "Up next",
};
