import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Unauthorized } from "../../contract/auth.ts";
import { homeFor, memberLanding } from "../client/session.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

/** The signed-in user, or null when signed out. */
export const getMe = createServerFn({ method: "GET" }).handler(() =>
  backend()
    .me(requestInfo())
    .catch(rescue(Unauthorized, () => null)),
);

/**
 * Where a fresh sign-in lands, as a redirect: an admin on its own home, a member on
 * {@link memberLanding} for the shops they belong to. Answers only when there is no session to
 * land: the verify endpoint sets the cookie before it sends the browser here, so that is a sign-in
 * that did not complete.
 */
export const resolveLanding = createServerFn({ method: "GET" }).handler(async () => {
  const me = await backend()
    .me(requestInfo())
    .catch(rescue(Unauthorized, () => null));
  if (me === null) return { error: "Couldn't complete sign-in." };
  if (me.role === "admin") throw redirect({ to: homeFor(me.role) });
  const shops = await backend().myShops(requestInfo());
  throw redirect({ href: memberLanding(shops) });
});
