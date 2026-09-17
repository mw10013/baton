import type * as Domain from "@/lib/Domain";

/**
 * The queue's order of presentation, top to bottom. The flagged tier first
 * because a flagged card is the one thing on the page that cannot wait; then
 * what the viewer themselves has in hand; then what a teammate has in hand (so
 * a person covering a bench sees the half-done work); then everything
 * untouched.
 *
 * The `attention` tier holds every flag, but its heading reads **Blocked**: a
 * held run is what a member sees there nearly always, and the reconcile flags
 * (quantity changed, order cancelled, already shipped) name themselves in
 * their own banner heading inside the card. One accurate word beats a
 * category name that describes nothing the reader can act on.
 */
export const TIERS = ["attention", "mine", "inProgress", "upNext"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  attention: "Blocked",
  mine: "Mine",
  inProgress: "In progress",
  upNext: "Up next",
};

/**
 * Which tier a queue row belongs in, from the rows the page already holds:
 * a flag wins; else a step the viewer started; else any started step; else
 * up next.
 *
 * "Mine" is by `startedByEmail`, not by the `startedBy` member id. Removing a
 * member and re-adding the same address mints a **new** `Member.id`
 * (`migrations/0001_init.sql`), so the id on a row taken before that stops
 * matching the person still standing at the bench, while the email — the
 * snapshot the migration calls the durable one — keeps matching. A merchant's
 * step has no email at all and so is nobody's, which is right: `Merchant` is
 * not a member of this queue.
 */
export const tierOf = (
  { run, steps }: Domain.QueueItem,
  memberEmail: Domain.Email,
): Tier => {
  if (run.flag !== null) return "attention";
  if (steps.some((step) => step.startedByEmail === memberEmail)) return "mine";
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
  memberEmail: Domain.Email,
): Record<Tier, readonly Domain.QueueItem[]> => {
  const tiered = items.map((item) => ({
    item,
    tier: tierOf(item, memberEmail),
  }));
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
