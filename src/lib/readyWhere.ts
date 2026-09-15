/**
 * A step is ready when it is open and nothing in an earlier stage of
 * the same run is still open. For an order run the item runs are stage
 * zero: its steps are ready only when no item run on the order is open
 * and at least one is done, so the order run exists from the moment
 * the order arrives (the merchant can see packing is coming) but
 * reaches nobody's queue until the items are made. Evaluated live, so
 * a line item added by a later edit, or a workflow attached by hand,
 * simply makes the order run wait longer. Every subquery is `exists`
 * and stops at its first row; `WorkflowRun_order_items_idx` serves
 * the two item-run probes. One definition, interpolated as a literal
 * with the outer alias, so the queue and every action agree.
 *
 * A module of its own rather than a closure in one repository because three
 * readers depend on agreeing exactly: the member queue (`listQueue`), every
 * step action's guard, and the orders index's waiting-on column and team
 * filter, which run inside `OrderRepository`. A second copy would drift, and a
 * merchant filter that disagrees with a worker's queue is worse than no filter.
 *
 * The inner subqueries bind the aliases `p`, `r` and `i`. A caller must not
 * use those for an outer table it joins: SQLite resolves an unqualified inner
 * reference against the innermost binding, so an outer `r` would silently be
 * shadowed rather than reported, and the predicate would look up the wrong
 * row. Pass the step's alias and name the outer run something else.
 */
export const readyWhere = (alias: string): string => `(
  ${alias}.completedAt is null
  and not exists (
    select 1 from WorkflowRunStep p
    where p.runId = ${alias}.runId and p.completedAt is null and p.stage < ${alias}.stage
  )
  and (
    exists (select 1 from WorkflowRun r where r.id = ${alias}.runId and r.lineItemId is not null)
    or (
      not exists (
        select 1 from WorkflowRun i
        join WorkflowRun r on r.orderId = i.orderId
        where r.id = ${alias}.runId and i.lineItemId is not null
          and i.status in ('pending', 'active')
      )
      and exists (
        select 1 from WorkflowRun i
        join WorkflowRun r on r.orderId = i.orderId
        where r.id = ${alias}.runId and i.lineItemId is not null
          and i.status = 'done'
      )
    )
  )
)`;
