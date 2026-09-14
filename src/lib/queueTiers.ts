import type * as Domain from "@/lib/Domain";

/**
 * The queue's order of presentation, top to bottom. Attention first because
 * a flagged card is the one thing on the page that cannot wait; then what
 * the viewer themselves has in hand; then what a teammate has in hand (so a
 * person covering a bench sees the half-done work); then everything untouched.
 */
export const TIERS = ["attention", "mine", "inProgress", "upNext"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  attention: "Needs attention",
  mine: "Mine",
  inProgress: "In progress",
  upNext: "Up next",
};

/**
 * Which tier a queue row belongs in, from the rows the page already holds:
 * a flag wins; else a step the viewer started; else any started step; else
 * up next. "Mine" is by `startedBy`, the member id snapshotted at Start, not
 * by email, so a member whose email the merchant re-enters still owns their
 * work.
 */
export const tierOf = (
  { run, steps }: Domain.QueueItem,
  memberId: Domain.MemberId,
): Tier => {
  if (run.flag !== null) return "attention";
  if (steps.some((step) => step.startedBy === memberId)) return "mine";
  if (steps.some((step) => step.startedAt !== null)) return "inProgress";
  return "upNext";
};

/**
 * Groups and sorts. Within a tier, oldest order first by
 * `run.orderProcessedAt` (the snapshot on the run, so no join), with the
 * order name and then the run id as tiebreaks so two runs of one order keep
 * a stable order between refetches.
 */
const byAge = (a: Domain.QueueItem, b: Domain.QueueItem) =>
  a.run.orderProcessedAt - b.run.orderProcessedAt ||
  a.run.orderName.localeCompare(b.run.orderName) ||
  a.run.id.localeCompare(b.run.id);

export const tierQueue = (
  items: readonly Domain.QueueItem[],
  memberId: Domain.MemberId,
): Record<Tier, readonly Domain.QueueItem[]> => {
  const tiered = items.map((item) => ({ item, tier: tierOf(item, memberId) }));
  const inTier = (wanted: Tier) =>
    tiered
      .filter(({ tier }) => tier === wanted)
      .map(({ item }) => item)
      .toSorted(byAge);
  return {
    attention: inTier("attention"),
    mine: inTier("mine"),
    inProgress: inTier("inProgress"),
    upNext: inTier("upNext"),
  };
};
