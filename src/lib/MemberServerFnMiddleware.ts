import { notFound, redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { tryPromisePassthrough } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

/**
 * Server-function auth middleware for the member area (`/shop/*`): validates
 * the better-auth session cookie and injects `{ user }`. Per-shop
 * authorization is separate ({@link requireMember}) because the shop lives in
 * the URL, which a function middleware cannot see — handlers receive it as
 * validated input and assert membership themselves.
 */
export const memberServerFnMiddleware = createMiddleware({
  type: "function",
}).server(({ next, context }) =>
  context.runEffect(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const request = yield* CurrentRequest;
      const sessionContext = yield* auth.getSession(request.headers);
      if (Option.isNone(sessionContext))
        return yield* Effect.fail(redirect({ to: "/login" }));
      return yield* tryPromisePassthrough(() =>
        next({ context: { user: sessionContext.value.user } }),
      );
    }),
  ),
);

/**
 * Asserts the session user's membership in the URL shop and returns the
 * branded shop. `notFound` rather than a redirect on a miss: a non-member must
 * not be able to distinguish "shop exists, you lack access" from "no such
 * shop". Membership's FK to `ShopSession` makes a hit proof of install too, so
 * downstream Durable Object access cannot revive a torn-down shop.
 */
export const requireMember = (input: {
  readonly shop: string;
  readonly email: Domain.Email;
}) =>
  Effect.gen(function* () {
    const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(input.shop);
    const repository = yield* Repository;
    const member = yield* repository.findMember({ shop, email: input.email });
    if (Option.isNone(member)) return yield* Effect.fail(notFound());
    return shop;
  });
