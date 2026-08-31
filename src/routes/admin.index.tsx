import { useRef } from "react";

import { createFileRoute, useRouter } from "@tanstack/react-router";

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string;
  }
}

export const Route = createFileRoute("/admin/")({
  component: RouteComponent,
});

/**
 * Admin landing page.
 *
 * The page's `secondary-actions` slot only accepts `s-button`/`s-button-group`,
 * so the Log out control is a bare `s-button` (not wrapped in a form). Logout is
 * POST-only, so its `onClick` submits a hidden POST form via {@link logoutFormRef}.
 */
function RouteComponent() {
  const router = useRouter();
  const logoutFormRef = useRef<HTMLFormElement>(null);
  return (
    <s-page heading={`Admin v${import.meta.env.VITE_APP_VERSION}`}>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        onClick={() => logoutFormRef.current?.submit()}
      >
        Log out
      </s-button>
      <form ref={logoutFormRef} method="post" action="/admin/logout" hidden />
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
