import type * as Domain from "@/lib/Domain";

import { Effect } from "effect";

import { type ReconcileContext, RunRepositoryError } from "@/lib/RunRepository";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

/**
 * What a pass reads besides the stored order, wired the way
 * `ShopWorkAgent.eligibleContext` wires it: `teams`, and the workflows found
 * by the order's tags through `WorkflowRepository.listActiveWorkflowsByTags`.
 */
export const reconcileContext = (teams: Domain.EligibleContext["teams"]) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    return {
      teams,
      workflowsByTags: (tags) =>
        workflows
          .listActiveWorkflowsByTags({ tags })
          .pipe(
            Effect.catchTag("WorkflowRepositoryError", (cause) =>
              Effect.fail(
                new RunRepositoryError({ message: cause.message, cause }),
              ),
            ),
          ),
    } satisfies ReconcileContext;
  });
