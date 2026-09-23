/**
 * The readiness rule of {@link Domain.WorkflowTask} as SQL: a task is ready
 * when it is open and no task in an earlier step of the same run is open.
 * `Domain.readyTasks` is the same rule over rows in hand, for the pages
 * and the seeder that cannot run SQL; a test holds the two together.
 * Evaluated live, so a task whose earlier step is reopened leaves the run
 * list again without a write. The subquery is `exists` and stops at its
 * first row. One definition, interpolated as a literal with the outer alias,
 * so the run list and every action agree.
 *
 * A module of its own rather than a closure in one repository because three
 * readers depend on agreeing exactly: the member's run list (`listRuns`), every
 * task action's guard, and the orders index's waiting-on column and team
 * filter, which run inside `OrderRepository`. A second copy would drift, and a
 * merchant filter that disagrees with a worker's run list is worse than no filter.
 *
 * The inner subquery binds the alias `p`. A caller must not use it for an
 * outer table it joins: SQLite resolves an unqualified inner reference
 * against the innermost binding, so an outer `p` would silently be shadowed
 * rather than reported, and the predicate would look up the wrong row. Pass
 * the task's alias and name the outer run something else.
 */
export const readyWhere = (alias: string): string => `(
  ${alias}.completedAt is null
  and not exists (
    select 1 from WorkflowRunTask p
    where p.runId = ${alias}.runId and p.completedAt is null and p.step < ${alias}.step
  )
)`;
