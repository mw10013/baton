import type * as React from "react";

import { Blocking } from "@/components/help/members/blocking";
import { FindingYourWork } from "@/components/help/members/finding-your-work";
import { RecordingYourWork } from "@/components/help/members/recording-your-work";
import { SigningIn } from "@/components/help/members/signing-in";

/**
 * The help pages' bodies, keyed `"<section>/<page>"` by the slugs in
 * `HELP_SECTIONS` (`src/lib/helpPages.ts`). A page whose key is here renders
 * its body between its lead and its foot list; a page without one renders
 * the lead and the foot list alone. Each body is one component under
 * `src/components/help/<section>/<page>.tsx`, registered here, so the tree
 * stays the one source of titles and slugs and a body cannot name a page the
 * tree lacks (the integration test resolves every key through the tree).
 * Bodies are screen copy: the retired-word lint reads `src/components/`.
 */
export const HELP_BODIES: Readonly<Record<string, () => React.JSX.Element>> = {
  "members/signing-in": SigningIn,
  "members/finding-your-work": FindingYourWork,
  "members/recording-your-work": RecordingYourWork,
  "members/blocking": Blocking,
};
