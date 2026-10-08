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
import { AttachingAWorkflow } from "@/components/help/orders/attaching-a-workflow";
import { FixingIssues } from "@/components/help/orders/fixing-issues";
import { OrderPage } from "@/components/help/orders/order-page";
import { OrdersList } from "@/components/help/orders/orders-list";
import { Syncing } from "@/components/help/orders/syncing";
import { AddingAMember } from "@/components/help/teams-and-members/adding-a-member";
import { CreatingATeam } from "@/components/help/teams-and-members/creating-a-team";
import { RemovingAndDeleting } from "@/components/help/teams-and-members/removing-and-deleting";
import { Creating } from "@/components/help/workflows/creating";
import { Editing } from "@/components/help/workflows/editing";
import { Managing } from "@/components/help/workflows/managing";
import { Matching } from "@/components/help/workflows/matching";
import { TurningOnAndOff } from "@/components/help/workflows/turning-on-and-off";

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
  "orders/orders-list": OrdersList,
  "orders/order-page": OrderPage,
  "orders/attaching-a-workflow": AttachingAWorkflow,
  "orders/fixing-issues": FixingIssues,
  "orders/syncing": Syncing,
  "workflows/creating": Creating,
  "workflows/editing": Editing,
  "workflows/matching": Matching,
  "workflows/turning-on-and-off": TurningOnAndOff,
  "workflows/managing": Managing,
  "teams-and-members/creating-a-team": CreatingATeam,
  "teams-and-members/adding-a-member": AddingAMember,
  "teams-and-members/removing-and-deleting": RemovingAndDeleting,
  "members/signing-in": SigningIn,
  "members/finding-your-work": FindingYourWork,
  "members/recording-your-work": RecordingYourWork,
  "members/blocking": Blocking,
};
