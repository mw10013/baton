/**
 * The step half of `currentTasks` as SQL: a task is current when it is
 * open and no task in an earlier step of the same run is open
 * (`WorkflowTask`), evaluated live from the tasks. The subquery is
 * `exists` and stops at its first row. One definition, interpolated as a
 * literal with the outer alias, so every action agrees.
 *
 * **It does not test the run's state.** `currentTasks` returns nothing
 * on a run that is not open (`runIsOpen`); this predicate reads
 * the task's own run's tasks and nothing else, so on a closed run it still
 * matches the open tasks the run keeps as its record. Every caller supplies
 * the run test: the task guards
 * check `runIsOpen` in `requireActionable` before they ask, and
 * `getRunPage` reads it only for an open run. Block's team gate
 * (`requireCurrentTeam`) runs inside writes that refuse a run that is not
 * open. A new caller adds the run test or reads the wrong tasks. The state
 * stays out of the predicate because every caller already holds the run.
 *
 * The list reads (the member's workflows list, the orders index's team filter and its Show
 * counts) test `Run.currentStep` instead, this rule kept on the row by the run repository's
 * `recomputeState` in the same statement as the run's state. They must agree with this
 * predicate exactly: a merchant filter that disagrees with a worker's workflows list, or either
 * with what a task action allows, is worse than no filter.
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
