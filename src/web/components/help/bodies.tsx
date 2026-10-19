import type { JSX } from "react";

/**
 * The help pages' bodies, keyed `"<section>/<page>"` by the slugs in `HELP_SECTIONS`. A page
 * whose key is here renders its body between its lead and its foot list; a page without one
 * renders the lead and the foot list alone. Each body is one component under
 * `components/help/<section>/<page>.tsx`, registered here, so the tree stays the one source of
 * titles and slugs and a body cannot name a page the tree lacks (the unit test resolves every key
 * through the tree).
 */
export const HELP_BODIES: Readonly<Record<string, () => JSX.Element>> = {};
