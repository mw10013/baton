import type * as Domain from "@/lib/Domain";

/**
 * The aside card answering "where is this team used?": the workflows whose
 * steps point at the team, each a link to where those steps are edited.
 *
 * It is a titled card in the page's aside rather than a sentence under the page
 * heading, because a bare paragraph is not something `s-page` lays out — it
 * lands on the page background between the header and the first card with
 * nothing naming it. The card drops the article the prose form put in front
 * of a workflow name: a list item is a name, and the heading already supplies
 * the framing.
 *
 * The `slot` lives on the section so the route can hand it straight to
 * `s-page`; the aside only renders while the page is `inlineSize="base"`.
 */
export function UsedByCard({
  workflows,
}: {
  readonly workflows: readonly Domain.TeamWorkflow[];
}) {
  return (
    <s-section slot="aside" heading="Used by" accessibilityLabel="Used by">
      {workflows.length === 0 ? (
        <s-paragraph color="subdued">Not used by any workflow yet.</s-paragraph>
      ) : (
        <s-stack gap="small-300" alignItems="start">
          {workflows.map((workflow) => (
            <s-stack
              key={workflow.workflowId}
              direction="inline"
              gap="small-300"
              alignItems="center"
            >
              <s-link href={`/app/workflows/${workflow.workflowId}`}>
                {workflow.workflowName}
              </s-link>
            </s-stack>
          ))}
        </s-stack>
      )}
    </s-section>
  );
}
