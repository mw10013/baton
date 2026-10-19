import type { JSX } from "react";
import { FirstOrder } from "./getting-started/first-order.tsx";
import { FirstTeam } from "./getting-started/first-team.tsx";
import { FirstWorkflow } from "./getting-started/first-workflow.tsx";
import { HowBatonWorks } from "./getting-started/how-baton-works.tsx";
import { Installing } from "./getting-started/installing.tsx";
import { AttachingAWorkflow } from "./orders/attaching-a-workflow.tsx";
import { FixingIssues } from "./orders/fixing-issues.tsx";
import { OrderPage } from "./orders/order-page.tsx";
import { OrdersList } from "./orders/orders-list.tsx";
import { Syncing } from "./orders/syncing.tsx";

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
};
