import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { WorkflowRepository } from "../../../../src/backend/shop-actor/workflow-repository.ts";
import type { TasksRevision } from "../../../../src/domain/shop-work.ts";

/** The writes that take the revision the editor read, by the same names on the repository and on `makeWorkflows`. */
const REVISED = [
  "addStep",
  "addTask",
  "updateTask",
  "moveTask",
  "separateTask",
  "joinTask",
  "removeTask",
  "applyDraft",
  "applyAndTurnOn",
  "discardDraft",
] as const;
type Revised = (typeof REVISED)[number];

/** Any write: the parameter is `never` so that every write's own input is assignable. */
type RevisedWrite = (input: never) => Effect.Effect<unknown, unknown, unknown>;

/** `T` whose writes read the revision themselves, so they are never stale. */
export type AtCurrentRevision<T extends Record<Revised, RevisedWrite>> = Omit<T, Revised> & {
  readonly [K in Revised]: (input: Omit<Parameters<T[K]>[0], "tasksRevision">) => ReturnType<T[K]>;
};

/**
 * `target`'s writes as a tab that has just re-read would send them: each carries the workflow's
 * current revision, read from `repo`. For the cases about something else; the stale-write cases
 * send an old revision themselves. A workflow or task that does not exist sends 0, and the write
 * then answers as it would without the guard.
 */
export const atCurrentRevision = <T extends Record<Revised, RevisedWrite>>(
  target: T,
  repo: WorkflowRepository,
): AtCurrentRevision<T> => {
  const ofWorkflow = (workflowId: string) =>
    repo.getWorkflow({ workflowId }).pipe(
      Effect.map(
        Option.match({
          onNone: (): TasksRevision => 0,
          onSome: (found) => found.tasksRevision,
        }),
      ),
      Effect.orDie,
    );
  const revisionOf = (input: { readonly workflowId: string } | { readonly taskId: string }) =>
    "workflowId" in input
      ? ofWorkflow(input.workflowId)
      : repo.getTask({ taskId: input.taskId }).pipe(
          Effect.orDie,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed<TasksRevision>(0),
              onSome: (found) => ofWorkflow(found.workflow.id),
            }),
          ),
        );
  const writes = Object.fromEntries(
    REVISED.map((name) => [
      name,
      (input: { readonly workflowId: string } | { readonly taskId: string }) =>
        revisionOf(input).pipe(
          Effect.flatMap((tasksRevision) =>
            (target[name] as (input: object) => Effect.Effect<unknown, unknown, unknown>)({
              ...input,
              tasksRevision,
            }),
          ),
        ),
    ]),
  );
  return { ...target, ...writes } as unknown as AtCurrentRevision<T>;
};
