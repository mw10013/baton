import { notFound, redirect } from "@tanstack/react-router";
import { Effect, Match, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import { SubscriptionPlan } from "@/lib/SubscriptionPlan";

/**
 * Asserts the session user's membership in the URL shop and returns that
 * membership's {@link Domain.MemberAccess} — the branded shop, the `memberId`,
 * and the active teams the member belongs to. `notFound` rather than a redirect
 * on a miss: a non-member must not be able to distinguish "shop exists, you
 * lack access" from "no such shop". Membership's FK to `ShopSession` makes a
 * hit proof of install too, so downstream Durable Object access cannot revive a
 * torn-down shop.
 *
 * Teams come back from the same query rather than a second call because they
 * are what scopes work: every member-area handler needs them, and an empty list
 * is the ordinary "not on a team yet" state, never a failed guard.
 *
 * Lives in its own module rather than beside `memberServerFnMiddleware`
 * because the Worker's WebSocket connect gate runs the identical check before
 * forwarding a member connection to `ShopAgent`, and the worker entry has no
 * business importing TanStack server-function middleware to get at it. One
 * definition, two callers: a page load and a socket connect authorize the same
 * way.
 *
 * The subscription check lives here, after membership, for the same reason:
 * every member surface — page loaders, server functions, the socket gate — runs
 * through this one function, so a shop whose plan lapses loses its members on
 * every surface at once, and no new surface can forget the check. Membership
 * first, plan second, so an unsubscribed shop still answers `notFound` to a
 * stranger: the lapse is the shop's business, not something to disclose to a
 * caller who has not proven they belong there.
 *
 * The lapse answer is a redirect to the member-facing lapsed page rather than
 * an error. A member cannot fix billing — only the merchant can, from `/app` —
 * so the page tells them to contact the shop owner and asks nothing of them.
 * The socket gate translates the same redirect into `402`, the status the
 * merchant gate already uses for the same condition.
 */
export const requireMember = (input: {
  readonly shop: string;
  readonly email: Domain.Email;
}) =>
  Effect.gen(function* () {
    const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(input.shop);
    const access = yield* (yield* Repository).findMemberAccess({
      shop,
      email: input.email,
    });
    if (Option.isNone(access)) return yield* Effect.fail(notFound());
    const status = yield* (yield* SubscriptionPlan).resolve(shop);
    return yield* Match.value(status).pipe(
      Match.tagsExhaustive({
        Subscribed: () => Effect.succeed(access.value),
        Unsubscribed: () =>
          Effect.fail(redirect({ to: "/shop/$shop/lapsed", params: { shop } })),
      }),
    );
  });
