// oxlint-disable-next-line unicorn/require-module-specifiers -- loads Shopify's Polaris JSX augmentation only
import type {} from "@shopify/polaris-types";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { useMatches, useNavigate, useRouter } from "@tanstack/react-router";

/**
 * `ErrorComponentProps["error"]` is `unknown` — a boundary catches whatever was
 * thrown, which need not be an `Error`. Normalizing here keeps the banner
 * readable for a thrown string or object instead of rendering `undefined`.
 */
export function DefaultErrorComponent({ error }: ErrorComponentProps) {
  const caught = error instanceof Error ? error : new Error(String(error));
  const navigate = useNavigate();
  const router = useRouter();
  const inApp = useMatches({
    select: (matches) => matches.some((m) => m.routeId === "/app"),
  });

  return (
    <s-page heading="Something went wrong">
      <s-section>
        <s-banner heading={caught.message} tone="critical">
          {caught.stack && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <pre style={{ margin: 0 }}>
                <code>{caught.stack}</code>
              </pre>
            </s-box>
          )}
          {/* router.invalidate() not reset(): default boundary catches errors
              from any source; only invalidate covers route-load errors
              (reloads loader + resets boundary). reset() alone re-throws
              stale load errors. refs tan-router data-loading.md:600 */}
          <s-button
            slot="secondary-actions"
            variant="secondary"
            onClick={() => void router.invalidate()}
          >
            Try again
          </s-button>
          {/* Only within the /app subtree (matches include the '/app' layout
              route): a default-boundary destination is otherwise an
              unfounded context assumption — root and "/" boundaries have no app home. */}
          {inApp && (
            <s-button
              slot="secondary-actions"
              variant="secondary"
              onClick={() => void navigate({ to: "/app" })}
            >
              Back to app home
            </s-button>
          )}
        </s-banner>
      </s-section>
    </s-page>
  );
}
