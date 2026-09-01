import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { Repository } from "@/lib/Repository";

const getMyShops = createServerFn({ method: "GET" })
  .middleware([memberServerFnMiddleware])
  .handler(({ context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        return {
          email: user.email,
          shops: yield* repository.listMemberShops(user.email),
        };
      }),
    ),
  );

const signOutFn = createServerFn({ method: "POST" })
  .middleware([memberServerFnMiddleware])
  .handler(({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const request = yield* CurrentRequest;
        yield* auth.signOut(request.headers);
        return yield* Effect.fail(redirect({ to: "/" }));
      }),
    ),
  );

export const Route = createFileRoute("/shop/")({
  loader: () => getMyShops(),
  component: RouteComponent,
});

function RouteComponent() {
  const { email, shops } = Route.useLoaderData();
  const signOut = useServerFn(signOutFn);
  const signOutMutation = useMutation({ mutationFn: () => signOut({}) });

  return (
    <s-page heading="Your shops" inlineSize="small">
      <s-section heading={email} accessibilityLabel="Your shops">
        {shops.length === 0 ? (
          <s-paragraph color="subdued">
            You do not have access to any shops yet. Ask your shop owner to add
            your email in their Baton members list.
          </s-paragraph>
        ) : (
          <s-stack gap="base">
            {shops.map((shop) => (
              <Link key={shop} to="/shop/$shop" params={{ shop }}>
                {shop}
              </Link>
            ))}
          </s-stack>
        )}
      </s-section>
      <s-section accessibilityLabel="Session">
        <s-stack alignItems="start">
          <s-button
            variant="tertiary"
            {...(signOutMutation.isPending ? { loading: true } : {})}
            onClick={() => {
              signOutMutation.mutate();
            }}
          >
            Sign out
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}
