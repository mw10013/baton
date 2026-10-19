import * as Duration from "effect/Duration";

/**
 * How long a live read is kept after its page stops showing it: the idle TTL of every live
 * query (`liveQuery`) and the router's `defaultGcTime` (`getRouter`), one number so the router
 * never renders a cached answer whose node is gone. A kept read costs memory, not requests: a
 * notice only marks it stale, and it refetches once when it is shown again. So the number bounds
 * how long a revisit can be answered from memory, not how stale it can paint.
 */
export const LIVE_RETENTION = Duration.minutes(5);
