import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ReturnPath } from "../../contract/auth.ts";
import SignInPage from "../components/SignInPage";
import { getMe } from "../server/session.ts";
import { requestMagicLink } from "../server/sign-in.ts";
import { homeFor } from "../client/session.ts";

/**
 * `redirect`: where a guard sent the visitor from. `error`: set by Better Auth when a magic
 * link fails (expired, used, not invited). A malformed value is dropped, not an error page.
 */
const SignInSearch = Schema.Struct({
  redirect: Schema.optional(ReturnPath),
  error: Schema.optional(Schema.String),
});
const decodeField = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): typeof SignInSearch.Type => ({
    redirect: decodeField(ReturnPath, search.redirect),
    error: decodeField(Schema.String, search.error),
  }),
  beforeLoad: async () => {
    const me = await getMe();
    if (me !== null)
      throw redirect({ to: me.role === "admin" ? homeFor(me.role) : "/login-callback" });
  },
  component: function SignInRoute() {
    const { redirect, error } = Route.useSearch();
    const request = useServerFn(requestMagicLink);
    return (
      <SignInPage
        returnTo={redirect}
        error={error}
        requestMagicLink={(input) => request({ data: input })}
      />
    );
  },
});
