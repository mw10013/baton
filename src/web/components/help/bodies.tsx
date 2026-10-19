import type { JSX } from "react";
import { FirstOrder } from "./getting-started/first-order.tsx";
import { FirstTeam } from "./getting-started/first-team.tsx";
import { FirstWorkflow } from "./getting-started/first-workflow.tsx";
import { HowBatonWorks } from "./getting-started/how-baton-works.tsx";
import { Installing } from "./getting-started/installing.tsx";
import { Blocking } from "./members/blocking.tsx";
import { FindingYourWork } from "./members/finding-your-work.tsx";
import { RecordingYourWork } from "./members/recording-your-work.tsx";
import { SigningIn } from "./members/signing-in.tsx";
import { AttachingAWorkflow } from "./orders/attaching-a-workflow.tsx";
import { FixingIssues } from "./orders/fixing-issues.tsx";
import { OrderPage } from "./orders/order-page.tsx";
import { OrdersList } from "./orders/orders-list.tsx";
import { Syncing } from "./orders/syncing.tsx";
import { AddingAMember } from "./teams-and-members/adding-a-member.tsx";
import { CreatingATeam } from "./teams-and-members/creating-a-team.tsx";
import { RemovingAndDeleting } from "./teams-and-members/removing-and-deleting.tsx";
import { Creating } from "./workflows/creating.tsx";
import { Editing } from "./workflows/editing.tsx";
import { Managing } from "./workflows/managing.tsx";
import { Matching } from "./workflows/matching.tsx";
import { TurningOnAndOff } from "./workflows/turning-on-and-off.tsx";

/**
 * The help pages' bodies, keyed `"<section>/<page>"` by the slugs in `HELP_SECTIONS`. A page
 * whose key is here renders its body between its lead and its foot list; a page without one
 * renders the lead and the foot list alone. Each body is one component under
 * `components/help/<section>/<page>.tsx`, registered here, so the tree stays the one source of
 * titles and slugs and a body cannot name a page the tree lacks (the unit test resolves every key
 * through the tree).
 */
export const HELP_BODIES: Readonly<Record<string, () => JSX.Element>> = {
  "getting-started/how-baton-works": HowBatonWorks,
  "getting-started/installing": Installing,
  "getting-started/first-team": FirstTeam,
  "getting-started/first-workflow": FirstWorkflow,
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
