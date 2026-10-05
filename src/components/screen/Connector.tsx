/**
 * The arrow between two stops of a step flow (the connector row of the parts
 * table on `ScreenPart` in `src/lib/Screen.ts`): the workflow page and the
 * editor draw a workflow as a column of stops, trigger then steps, and the
 * arrow says the column is an order, not a list.
 */
export function Connector() {
  return (
    <s-stack direction="inline" justifyContent="center">
      <s-icon type="arrow-down" color="subdued" size="small" />
    </s-stack>
  );
}
