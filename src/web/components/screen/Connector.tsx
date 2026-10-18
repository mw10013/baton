/**
 * The arrow between two stops of a step flow: the workflow page and the editor draw a workflow as
 * a column of stops, trigger then steps, and the arrow says the column is an order, not a list.
 *
 * | part      | job                                        | component   | fixes                | used on         | never                          |
 * | --------- | ------------------------------------------ | ----------- | -------------------- | --------------- | ------------------------------ |
 * | connector | the arrow between two stops of a step flow | `Connector` | centred on the column | details, editor | an arrow before the first stop |
 */
export function Connector() {
  return (
    <s-stack direction="inline" justifyContent="center">
      <s-icon type="arrow-down" color="subdued" size="small" />
    </s-stack>
  );
}
