import { StrictMode, startTransition } from "react";

import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";

/**
 * Explicit client entry, otherwise identical to Start's default
 * (`refs/tan-start/packages/react-start/src/default-entry/client.tsx`). It
 * exists for one option: `onRecoverableError`. React 19 treats a hydration
 * mismatch as recoverable — it logs, throws the SSR tree away, and re-renders
 * the whole root on the client — so a mismatch never fails a test or a page,
 * it only silently costs a full client render on every load. Polaris custom
 * elements upgrade before React hydrates (the script sits before `<Scripts />`
 * in `__root.tsx`), which is exactly the kind of race that produces such a
 * mismatch intermittently. Logging every recoverable error with a stable
 * prefix makes the class greppable in the console and in Playwright's
 * `page.on("console")` rather than something noticed by luck.
 */
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    {
      onRecoverableError: (error, errorInfo) => {
        console.error(
          "hydration.recoverable:",
          error,
          errorInfo.componentStack,
        );
      },
    },
  );
});
