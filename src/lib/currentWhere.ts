/**
 * The step half of `Domain.currentTasks` as SQL: a task is current when it is
 * open and no task in an earlier step of the same run is open
 * ({@link Domain.WorkflowTask}). Evaluated live, so a task whose earlier step
 * is reopened leaves the workflows list again without a write. The subquery is
 * `exists` and stops at its first row. One definition, interpolated as a
 * literal with the outer alias, so the workflows list and every action agree.
 *
 * **It does not test the run's status.** `Domain.currentTasks` returns nothing
 * on a run that is not open ({@link Domain.runIsOpen}); this predicate reads
 * the task's own run's tasks and nothing else, so on a closed run it still
 * matches the open tasks the run keeps as its record. Every caller supplies
 * the run test: `RunRepository.listRuns` and `OrderRepository`'s waiting-on
 * column and team filter join `Run` with `status = 'active'`, the task guards
 * check {@link Domain.runIsOpen} in `requireActionable` before they ask, and
 * `getRunView` reads it only for an open run. Block's team gate
 * (`requireCurrentTeam`) runs inside writes that refuse a run that is not
 * open. A new caller adds the run test or reads the wrong tasks. The status
 * stays out of the predicate because every caller already joins or holds the
 * run, and a second `Run` lookup per task row would be paid on the workflows list's
 * hottest query.
 *
 * A module of its own rather than a closure in one repository because three
 * readers depend on agreeing exactly: the member's workflows list (`listRuns`), every
 * task action's guard, and the orders index's waiting-on column and team
 * filter, which run inside `OrderRepository`. A second copy would drift, and a
 * merchant filter that disagrees with a worker's workflows list is worse than no filter.
 *
 * The inner subquery binds the alias `p`. A caller must not use it for an
 * outer table it joins: SQLite resolves an unqualified inner reference
 * against the innermost binding, so an outer `p` would silently be shadowed
 * rather than reported, and the predicate would look up the wrong row. Pass
 * the task's alias and name the outer run something else.
 */
export const currentWhere = (alias: string): string => `(
  ${alias}.doneAt is null
  and not exists (
    select 1 from RunTask p
    where p.runId = ${alias}.runId and p.doneAt is null and p.step < ${alias}.step
  )
)`;
