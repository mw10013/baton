import { createFileRoute } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { D1Primary } from "@/lib/D1Primary";
import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

/** `team: null` seeds the step unassigned, the state a team delete leaves behind. */
const SeedStepByTeamName = Schema.Struct({
  name: Domain.StepName,
  team: Schema.NullOr(Domain.TeamName),
  stage: Schema.optionalKey(Schema.Number),
  instructions: Schema.optionalKey(Domain.StepInstructions),
});

const DevSeedInput = Schema.Struct({
  shop: Domain.Shop,
  members: Schema.Array(Domain.Email),
  /** A team with an empty `members` list seeds the "No members" state. */
  teams: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Domain.TeamName,
        members: Schema.Array(Domain.Email),
      }),
    ),
  ),
  /**
   * Steps name their team rather than carrying a `teamId`: team ids are
   * `crypto.randomUUID()` minted by the seed itself moments earlier, so a
   * caller could not know one, and the name is what makes the fixture readable
   * as data.
   */
  workflows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Domain.WorkflowName,
        /** Defaults to on when the entry has steps and every step is assigned; see `Domain.SeedWorkflowsInput`. */
        active: Schema.optionalKey(Schema.Boolean),
        tag: Domain.WorkflowTag,
        steps: Schema.Array(SeedStepByTeamName),
        /** A pending draft beside the workflow's `steps`; the tag is not drafted. */
        draft: Schema.optionalKey(
          Schema.Struct({ steps: Schema.Array(SeedStepByTeamName) }),
        ),
      }),
    ),
  ),
  /**
   * Seeded after workflows so they route. `done` orders are completed as the
   * first listed member, so every finished step names a real member.
   */
  orders: Schema.optionalKey(Domain.SeedOrdersInput.fields.orders),
  /**
   * Keep the better-auth identity (`User`, and the `Session` rows that cascade
   * from it) of every listed email instead of deleting it, so a browser that
   * is already signed in stays signed in across the re-seed. Off by default:
   * a run normally wants a first-time user.
   *
   * Exists for Playwright's member project, where a sign-in costs one of the
   * 5 magic-link sends `LOGIN_LIMITER` allows per 60 seconds across the whole
   * run (`wrangler.jsonc`). A spec that re-seeds between tests — which is how
   * every member spec gets a pristine fixture — cannot afford a fresh sign-in
   * each time, so it signs in once and re-seeds with this on. Membership,
   * teams, workflows and orders are still replaced wholesale; only the
   * identity survives.
   */
  keepIdentities: Schema.optionalKey(Schema.Boolean),
});

/**
 * Development fixture endpoint, driven by `pnpm seed` and by Playwright
 * (`e2e/seed.ts`). Replaces a shop's membership with exactly `members`, its
 * teams with exactly `teams`, its workflow definitions with exactly
 * `workflows`, and (unless `keepIdentities` is set) drops the better-auth
 * identity of every listed email, so each run signs in as a first-time user.
 * It ends by closing the sockets of the members it replaced, the way the
 * roster screens do. Enabled only for
 * `ENVIRONMENT === "local"`; deployed environments receive 404. Local state is
 * disposable, so the endpoint intentionally has no caller authorization.
 *
 * Named `dev`, not `e2e`, because the gate is the environment rather than the
 * test runner: Playwright is one of two peer callers, and an `e2e` name invites
 * someone editing tests to reshape the prototyping fixture unaware.
 *
 * Writes through `D1Primary` for the same reason `Repository.addMember` does:
 * the sign-in gate reads membership off the primary, and a seed that landed on
 * a replica-lagged path could let the very next `/login` deny a member it just
 * granted.
 *
 * `Verification` is wiped wholesale rather than filtered by email: better-auth
 * keys magic-link rows by an opaque token identifier, not by the address, so
 * there is nothing to filter on — and a stale unconsumed link for the seeded
 * email is exactly what would make a retry sign in through the previous run's
 * URL. Deleting `User` cascades that email's `Session` and `Account` rows
 * (`migrations/0001_init.sql:57,70`).
 *
 * Deliberately does NOT seed `ShopSession`: `Member.shop` FKs to it, so seeding
 * a shop the app is not installed on fails loudly here instead of surfacing
 * later as a `/shop/$shop` 500 from a fabricated offline token. That FK is also
 * why the whole fixture is an endpoint rather than rows in
 * `migrations/0001_init.sql` — a migration runs before any install exists.
 *
 * Workflows go to the shop's Durable Object last, once teams have ids to point
 * at: `WorkflowStep.teamId` is a D1 `Team.id` with no foreign key, because
 * SQLite keys do not cross databases. The stub is called directly rather than
 * through `ShopAgentClient`, which exists to decode RPC results against a
 * schema — there is no result here to decode.
 *
 * `Team` is deleted explicitly rather than left to a cascade: it hangs off
 * `ShopSession`, not `Member`, so wiping membership would leave the previous
 * run's teams behind and make "no teams yet" untestable. `TeamMember` needs no
 * such handling — it cascades from the `Member` delete above.
 */
export const Route = createFileRoute("/api/dev/seed")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const env = yield* CloudflareEnv;
            if (env.ENVIRONMENT !== "local")
              return new Response("Not Found", { status: 404 });
            const request = yield* CurrentRequest;
            return yield* Effect.gen(function* () {
              const {
                shop,
                members,
                teams,
                workflows,
                orders,
                keepIdentities,
              } = yield* Schema.decodeUnknownEffect(DevSeedInput)(
                yield* Effect.tryPromise(() => request.json()),
              );
              const sql = yield* D1Primary;
              const repository = yield* Repository;
              // Checked rather than left to the FK: `Member.shop` and
              // `Team.shop` reference `ShopSession`, so seeding a shop the app
              // is not installed on surfaces as an opaque
              // `FOREIGN KEY constraint failed` 500 several statements later.
              if (
                Option.isNone(yield* repository.findShopSessionRedacted(shop))
              )
                return new Response(
                  `no ShopSession for ${shop}: install the app on that shop first (run pnpm app:dev and open the app in the store)`,
                  { status: 409 },
                );
              // Read before the delete: these are the ids any live member
              // socket is tagged with, and the only ones worth revoking below.
              const priorMemberIds = (yield* repository.listMembers(shop)).map(
                (member) => member.id,
              );
              yield* sql`delete from Team where shop = ${shop}`;
              yield* sql`delete from Member where shop = ${shop}`;
              yield* sql`delete from Verification`;
              for (const email of members) {
                if (keepIdentities !== true)
                  yield* sql`delete from User where email = ${email}`;
                // The seed is local-only and has no plan to resolve, so it
                // seeds against the widest tier rather than a merchant's.
                yield* repository.addMember({
                  shop,
                  email,
                  limit: Domain.MAX_ENTITLEMENTS.maxMembers,
                });
              }
              const memberIds = new Map(
                (yield* repository.listMembers(shop)).map((member) => [
                  member.email,
                  member.id,
                ]),
              );
              const teamIds = new Map<Domain.TeamName, Domain.TeamId>();
              for (const team of teams ?? []) {
                const { id: teamId } = yield* repository.createTeam({
                  shop,
                  name: team.name,
                });
                teamIds.set(team.name, teamId);
                for (const email of team.members) {
                  const memberId = memberIds.get(email);
                  if (memberId === undefined)
                    return new Response(
                      `team ${team.name} references unseeded member ${email}`,
                      { status: 400 },
                    );
                  yield* repository.setTeamMember({
                    shop,
                    teamId,
                    memberId,
                    inTeam: true,
                  });
                }
              }
              type SeedStep =
                (typeof Domain.SeedWorkflowsInput.Encoded)["workflows"][number]["steps"][number];
              const seedWorkflows: {
                name: string;
                active?: boolean;
                tag: string;
                steps: SeedStep[];
                draft?: { steps: SeedStep[] };
              }[] = [];
              /** Team names → ids; the first step naming an unseeded team is the whole error. */
              const resolveSteps = (
                workflowName: string,
                steps: readonly (typeof SeedStepByTeamName.Type)[],
              ): SeedStep[] | Response => {
                const resolved: SeedStep[] = [];
                for (const step of steps) {
                  const teamId =
                    step.team === null ? null : teamIds.get(step.team);
                  if (teamId === undefined)
                    return new Response(
                      `workflow ${workflowName} step ${step.name} references unseeded team ${step.team ?? ""}`,
                      { status: 400 },
                    );
                  resolved.push({
                    name: step.name,
                    teamId,
                    ...(step.stage === undefined ? {} : { stage: step.stage }),
                    ...(step.instructions === undefined
                      ? {}
                      : { instructions: step.instructions }),
                  });
                }
                return resolved;
              };
              for (const workflow of workflows ?? []) {
                const steps = resolveSteps(workflow.name, workflow.steps);
                if (steps instanceof Response) return steps;
                const draftSteps =
                  workflow.draft === undefined
                    ? undefined
                    : resolveSteps(workflow.name, workflow.draft.steps);
                if (draftSteps instanceof Response) return draftSteps;
                const draft =
                  workflow.draft === undefined || draftSteps === undefined
                    ? undefined
                    : { steps: draftSteps };
                seedWorkflows.push({
                  name: workflow.name,
                  ...(workflow.active === undefined
                    ? {}
                    : { active: workflow.active }),
                  tag: workflow.tag,
                  steps,
                  ...(draft === undefined ? {} : { draft }),
                });
              }
              // Always called, even with no workflows: an empty fixture must
              // still clear what the previous seed left in the object.
              yield* Effect.tryPromise(() =>
                env.SHOP_AGENT.getByName(shop).seedWorkflows({
                  workflows: seedWorkflows,
                }),
              );
              const seedMemberEmail = members[0];
              const seedMemberId =
                seedMemberEmail === undefined
                  ? undefined
                  : memberIds.get(seedMemberEmail);
              if (seedMemberId === undefined && (orders ?? []).length > 0)
                return new Response("orders need at least one seeded member", {
                  status: 400,
                });
              // Always called: an empty fixture must clear the previous run's orders.
              if (seedMemberId !== undefined && seedMemberEmail !== undefined)
                yield* Effect.tryPromise(() =>
                  env.SHOP_AGENT.getByName(shop).seedOrders({
                    memberId: seedMemberId,
                    memberEmail: seedMemberEmail,
                    orders: orders ?? [],
                  }),
                );
              // Last, once every write has landed, and with the PRE-seed ids:
              // a seed rewrites `Member` wholesale, so a member holding an
              // open socket is carrying a `memberId` and `teamIds` that no
              // longer exist. This is the same close the roster screens issue
              // after their own D1 writes (`app.members`,
              // `app.teams.$teamId`) — the socket reconnects through the
              // Worker's gate and comes back with the membership this seed
              // just wrote, and `/shop/$shop` invalidates its router on the
              // close so the page's loader data follows.
              if (priorMemberIds.length > 0)
                yield* Effect.tryPromise(() =>
                  env.SHOP_AGENT.getByName(shop).revokeMemberConnections({
                    memberIds: priorMemberIds,
                  }),
                );
              return Response.json({
                ok: true,
                shop,
                members,
                teams,
                workflows,
                orders,
              });
            }).pipe(
              Effect.catchTag("SchemaError", (error) =>
                Effect.succeed(new Response(String(error), { status: 400 })),
              ),
            );
          }),
        ),
    },
  },
});
