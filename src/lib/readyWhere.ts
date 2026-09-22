/**
 * A step is ready when it is open and nothing in an earlier stage of
 * the same run is still open. `Domain.readySteps` is the same rule over
 * rows in hand, for the pages and the seeder that cannot run SQL; a test
 * holds the two together. Evaluated live, so a step whose earlier
 * stage is reopened leaves the run list again without a write. The
 * subquery is `exists` and stops at its first row. One definition,
 * interpolated as a literal with the outer alias, so the run list and
 * every action agree.
 *
 * A module of its own rather than a closure in one repository because three
 * readers depend on agreeing exactly: the member's run list (`listRuns`), every
 * step action's guard, and the orders index's waiting-on column and team
 * filter, which run inside `OrderRepository`. A second copy would drift, and a
 * merchant filter that disagrees with a worker's run list is worse than no filter.
 *
 * The inner subquery binds the alias `p`. A caller must not use it for an
 * outer table it joins: SQLite resolves an unqualified inner reference
 * against the innermost binding, so an outer `p` would silently be shadowed
 * rather than reported, and the predicate would look up the wrong row. Pass
 * the step's alias and name the outer run something else.
 */
export const readyWhere = (alias: string): string => `(
  ${alias}.completedAt is null
  and not exists (
    select 1 from WorkflowRunStep p
    where p.runId = ${alias}.runId and p.completedAt is null and p.stage < ${alias}.stage
  )
)`;
