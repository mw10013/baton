import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { adminServerFnMiddleware } from "@/lib/AdminServerFnMiddleware";
import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string;
  }
}

const signOutFn = createServerFn({ method: "POST" })
  .middleware([adminServerFnMiddleware])
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

export const Route = createFileRoute("/admin/")({
  component: RouteComponent,
});

/**
 * Admin landing page. Sign-out is a server fn (not a POST route): the
 * `tanstackStartCookies` plugin forwards better-auth's cleared session cookie
 * through TanStack's request storage from a server fn, the same path
 * `/shop` uses. `disabled={!hydrated}` because SSR'd markup is React-dead
 * until hydration and the click would be silently dropped.
 */
function RouteComponent() {
  const router = useRouter();
  const hydrated = useHydrated();
  const signOut = useServerFn(signOutFn);
  const signOutMutation = useMutation({ mutationFn: () => signOut({}) });
  return (
    <s-page heading={`Admin v${import.meta.env.VITE_APP_VERSION}`}>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        disabled={!hydrated}
        {...(signOutMutation.isPending ? { loading: true } : {})}
        onClick={() => {
          signOutMutation.mutate();
        }}
      >
        Sign out
      </s-button>
      <s-section accessibilityLabel="Admin overview">
        <s-stack gap="base" alignItems="start">
          <s-heading>Shops</s-heading>
          <s-paragraph>
            View connected shops and their stored Shopify sessions.
          </s-paragraph>
          <s-button
            variant="primary"
            onClick={() => void router.navigate({ to: "/admin/shops" })}
          >
            View shops
          </s-button>
        </s-stack>
      </s-section>
      <s-section accessibilityLabel="Shop Agent objects overview">
        <s-stack gap="base" alignItems="start">
          <s-heading>Shop Agent Objects</s-heading>
          <s-paragraph>
            View Cloudflare Durable Objects for Shop Agent instances.
          </s-paragraph>
          <s-button
            variant="primary"
            onClick={() =>
              void router.navigate({ to: "/admin/shop-agent-objects" })
            }
          >
            View objects
          </s-button>
        </s-stack>
      </s-section>
      <s-section accessibilityLabel="Orphan Shop Agent objects overview">
        <s-stack gap="base" alignItems="start">
          <s-heading>Orphan Shop Agent Objects</s-heading>
          <s-paragraph>
            Find Shop Agent objects with no installed shop and destroy them,
            without re-creating any.
          </s-paragraph>
          <s-button
            variant="primary"
            onClick={() =>
              void router.navigate({ to: "/admin/orphan-shop-agent-objects" })
            }
          >
            View orphans
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}
