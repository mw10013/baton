import type * as React from "react";

import { FirstOrder } from "@/components/help/getting-started/first-order";
import { FirstTeam } from "@/components/help/getting-started/first-team";
import { FirstWorkflow } from "@/components/help/getting-started/first-workflow";
import { HowBatonWorks } from "@/components/help/getting-started/how-baton-works";
import { Installing } from "@/components/help/getting-started/installing";
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
  "getting-started/how-baton-works": HowBatonWorks,
  "getting-started/installing": Installing,
  "getting-started/first-workflow": FirstWorkflow,
  "getting-started/first-team": FirstTeam,
  "getting-started/first-order": FirstOrder,
  "members/signing-in": SigningIn,
  "members/finding-your-work": FindingYourWork,
  "members/recording-your-work": RecordingYourWork,
  "members/blocking": Blocking,
};
