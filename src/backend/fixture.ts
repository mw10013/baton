import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FIXTURE_ORDER_PREFIX,
  FixtureConflict,
  type FixtureCounts,
  type FixtureOrderChange,
  type FixtureProgress,
  type FixtureTask,
  LineItemProperty,
  ShopNotInstalled,
  type ShopFixtureData,
  stepsOf,
  workflowStateOf,
} from "../contract/fixture.ts";
import type { ShopKey } from "../domain/platform.ts";
import { type ShopIdentity, MembershipRepository } from "./membership-repository.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";

/** A task as `Workflow.tasks` stores it: its position is its index, so it is not stored. */
const StoredTask = Schema.Struct({
  id: Schema.String,
  step: Schema.Int,
  name: Schema.String,
  teamId: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
});
const encodeTasks = Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredTask)));
const encodeTags = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeProperties = Schema.encodeSync(Schema.fromJsonString(Schema.Array(LineItemProperty)));

/** A `Workflow` row of the shop actor. */
export interface WorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly state: "active" | "inactive";
  readonly updatedAt: number;
  readonly tasks: string;
  readonly draftTasks: string | null;
}

/** A `ShopOrder` row of the shop actor; `fullyPaid` is SQLite's 0 or 1. */
export interface OrderRow {
  readonly id: string;
  readonly legacyId: string;
  readonly name: string;
  readonly processedAt: number;
  readonly updatedAt: number;
  readonly cancelledAt: number | null;
  readonly fulfillmentStatus: string;
  readonly fullyPaid: 0 | 1;
  readonly note: string | null;
  readonly syncedAt: number;
  readonly countedAt: number;
}

/** An `OrderLineItem` row of the shop actor; the two JSON columns are encoded. */
export interface LineItemRow {
  readonly id: string;
  readonly orderId: string;
  readonly title: string;
  readonly variantTitle: string | null;
  readonly sku: string | null;
  readonly quantity: number;
  readonly currentQuantity: number;
  readonly productTags: string;
  readonly properties: string;
}

/**
 * A fixture member as the actor records a seeded step: legacy's seed member list, in the
 * fixture's order, with the D1 ids minted for it. The actor reads it, never D1, to name who
 * started, did or blocked a seeded step.
 */
export interface FixtureMemberRow {
  readonly memberId: string;
  readonly email: string;
  readonly teamIds: ReadonlyArray<string>;
}

/**
 * What the actor applies to one fixture order's runs once its rows are in and the shop's teams
 * are in D1: each item's chosen workflow (the minted `WorkflowRow.id`) and its progress (the
 * item's own, or the order's keys), then the order's `after`.
 */
export interface FixtureOrderWork {
  readonly orderId: string;
  readonly items: ReadonlyArray<{
    readonly lineItemId: string;
    readonly workflowId: string | null;
    readonly progress: FixtureProgress;
  }>;
  readonly after: FixtureOrderChange | null;
}

/** The rows a fixture puts in the shop actor, and the work its runs are given after. */
export interface ActorFixtureRows {
  readonly workflows: ReadonlyArray<WorkflowRow>;
  readonly orders: ReadonlyArray<OrderRow>;
  readonly lineItems: ReadonlyArray<LineItemRow>;
  readonly members: ReadonlyArray<FixtureMemberRow>;
  readonly work: ReadonlyArray<FixtureOrderWork>;
}

/** The shop actor's work rows, counted after a fixture write. */
export interface ActorFixtureCounts {
  readonly workflows: number;
  readonly orders: number;
  readonly lineItems: number;
}

/** What the shop actor's `addFixture` answers: the counts, or the first clash it found. */
export type ActorFixtureAdded =
  | { readonly _tag: "Added"; readonly counts: ActorFixtureCounts }
  | { readonly _tag: "Conflict"; readonly reason: string };

const DAY_MS = 86_400_000;

/** An order's progress keys as one item's progress: every key but the order's own fields. */
const progressOf = ({
  done,
  advance,
  started,
  blocked,
  byMerchant,
  by,
  cancelled,
}: FixtureProgress): FixtureProgress => ({
  ...(done === undefined ? {} : { done }),
  ...(advance === undefined ? {} : { advance }),
  ...(started === undefined ? {} : { started }),
  ...(blocked === undefined ? {} : { blocked }),
  ...(byMerchant === undefined ? {} : { byMerchant }),
  ...(by === undefined ? {} : { by }),
  ...(cancelled === undefined ? {} : { cancelled }),
});

/**
 * The rows a fixture becomes, at `now`, with ids from `newId`: D1's identity rows and the actor's
 * work rows. Team ids are minted first, so a task's `teamId` is the D1 id of the team it names.
 * Fixture orders have deterministic ids under {@link FIXTURE_ORDER_PREFIX}.
 *
 * Orders are stored as placed: an order's `after` (cancelled, a new fulfillment status, new item
 * quantities) is carried in `work`, which the actor applies through an upsert once the order's
 * runs exist, so reconcile closes and resizes them. Each item's `workflow` and progress (its own,
 * or the order's keys but `note`, which is the order note) are carried there too; the actor's
 * `applyFixture` applies them.
 *
 * An order's `processedAt` is `placedDaysAgo` days before `now`, plus its index in the list in
 * milliseconds, so orders placed the same day still sort by number. `countedAt` is 0, so usage
 * never counts a fixture order.
 */
export const fixtureRows = (
  data: ShopFixtureData,
  now: number,
  newId: () => string,
): { readonly identity: ShopIdentity; readonly actor: ActorFixtureRows } => {
  const memberIds = new Map(data.members.map((email) => [email, newId()]));
  const teamIds = new Map(data.teams.map((team) => [team.name, newId()]));
  const identity: ShopIdentity = {
    members: data.members.map((email) => ({
      id: memberIds.get(email) ?? newId(),
      email,
      createdAt: now,
    })),
    teams: data.teams.map((team) => ({
      id: teamIds.get(team.name) ?? newId(),
      name: team.name,
      createdAt: now,
    })),
    teamMembers: data.teams.flatMap((team) =>
      team.members.flatMap((email) => {
        const teamId = teamIds.get(team.name);
        const memberId = memberIds.get(email);
        return teamId === undefined || memberId === undefined
          ? []
          : [{ teamId, memberId, createdAt: now }];
      }),
    ),
  };

  const storedTasks = (tasks: ReadonlyArray<FixtureTask>) => {
    const steps = stepsOf(tasks);
    return encodeTasks(
      tasks.map((task, index) => ({
        id: newId(),
        step: steps[index] ?? index + 1,
        name: task.name,
        teamId: task.team === null ? null : (teamIds.get(task.team) ?? null),
        instructions: task.instructions ?? null,
      })),
    );
  };
  const workflows = data.workflows.map((workflow): WorkflowRow => ({
    id: newId(),
    name: workflow.name,
    tag: workflow.tag,
    state: workflowStateOf(workflow),
    updatedAt: now,
    tasks: storedTasks(workflow.tasks),
    draftTasks: workflow.draft === undefined ? null : storedTasks(workflow.draft.tasks),
  }));

  const workflowIds = new Map(workflows.map((workflow) => [workflow.name, workflow.id]));
  const orders: Array<OrderRow> = [];
  const lineItems: Array<LineItemRow> = [];
  const work: Array<FixtureOrderWork> = [];
  data.orders.forEach((order, index) => {
    const legacyId = `${FIXTURE_ORDER_PREFIX}${order.n}`;
    const id = `gid://shopify/Order/${legacyId}`;
    orders.push({
      id,
      legacyId,
      name: `#${order.n}`,
      processedAt: now - (order.placedDaysAgo ?? 0) * DAY_MS + index,
      updatedAt: now,
      cancelledAt: null,
      fulfillmentStatus: order.fulfillmentStatus ?? "UNFULFILLED",
      fullyPaid: order.unpaid === true ? 0 : 1,
      note: order.note ?? null,
      syncedAt: now,
      countedAt: 0,
    });
    const { lineItems: _items, after, note: _note, n: _n, ...orderProgress } = order;
    work.push({
      orderId: id,
      items: order.lineItems.map((item, itemIndex) => ({
        lineItemId: `${id}/line-${itemIndex + 1}`,
        workflowId: item.workflow === undefined ? null : (workflowIds.get(item.workflow) ?? null),
        progress: item.progress ?? progressOf(orderProgress),
      })),
      after: after ?? null,
    });
    order.lineItems.forEach((item, itemIndex) => {
      const position = itemIndex + 1;
      lineItems.push({
        id: `${id}/line-${position}`,
        orderId: id,
        title: item.title,
        variantTitle: item.variantTitle ?? null,
        sku: item.sku ?? null,
        quantity: item.quantity,
        currentQuantity: item.currentQuantity ?? item.quantity,
        productTags: encodeTags(item.tags),
        properties: encodeProperties(item.properties),
      });
    });
  });
  const members = data.members.map((email): FixtureMemberRow => ({
    memberId: memberIds.get(email) ?? "",
    email,
    teamIds: data.teams.flatMap((team) =>
      team.members.includes(email) ? [teamIds.get(team.name) ?? ""] : [],
    ),
  }));
  return { identity, actor: { workflows, orders, lineItems, members, work } };
};

const make = Effect.gen(function* () {
  const sessions = yield* ShopSessionRepository;
  const members = yield* MembershipRepository;
  const actors = yield* ShopActors;

  /**
   * Replaces one installed shop's data with `data`: D1's identity rows in one batch, then the
   * actor's work rows in one transaction, then the work on their runs (`applyFixture`, which
   * reads the teams just written to D1), then a revoke of every member it replaced, whose
   * sockets carry ids that no longer exist. Each store is atomic on its own; a failure between
   * them leaves the new identity beside the old work, which the next load replaces. The shop's
   * session, other shops and Better Auth are never touched.
   */
  const load = Effect.fn("Fixtures.load")(function* (shop: ShopKey, data: ShopFixtureData) {
    if (Option.isNone(yield* sessions.find(shop))) return yield* new ShopNotInstalled({ shop });
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* Effect.sync(() => fixtureRows(data, now, () => crypto.randomUUID()));
    const identity = yield* members.replaceShop(shop, rows.identity);
    const work = yield* actors.loadFixture(shop, rows.actor);
    yield* actors.applyFixture(shop, rows.actor, "loadFixture");
    // Best effort, as `ShopActors.revoke` is: the write has landed either way.
    yield* Effect.forEach(
      identity.priorMemberIds,
      (id) => actors.revoke(shop, { by: "member", id }),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    const counts: FixtureCounts = { members: identity.members, teams: identity.teams, ...work };
    yield* Effect.logInfo(
      `Fixtures.load: shop=${shop} members=${counts.members} teams=${counts.teams} workflows=${counts.workflows} orders=${counts.orders} lineItems=${counts.lineItems}`,
    );
    return counts;
  });

  /**
   * Adds `data` to one installed shop beside its data, revoking nothing. It reads D1 for a
   * member email or team name already in the shop and fails with {@link FixtureConflict} before
   * anything is written; then the actor adds its rows, failing the same way on a clashing
   * workflow or order with nothing written; then D1's identity rows go in, in one batch, whose
   * unique indexes are only the backstop for a race (a clash there is a defect); then the actor
   * applies the work on the fixture's runs (`applyFixture`), after D1, so the fixture's teams
   * make its workflows eligible. D1 is never written first: an actor `Conflict` would leave its
   * rows behind. As with {@link load}, each store is atomic on its own.
   */
  const add = Effect.fn("Fixtures.add")(function* (shop: ShopKey, data: ShopFixtureData) {
    if (Option.isNone(yield* sessions.find(shop))) return yield* new ShopNotInstalled({ shop });
    const names = yield* members.identityNames(shop);
    const email = data.members.find((address) => names.emails.includes(address));
    if (email !== undefined)
      return yield* new FixtureConflict({ shop, reason: `member ${email} already exists` });
    const team = data.teams.find(({ name }) => names.teams.includes(name));
    if (team !== undefined)
      return yield* new FixtureConflict({ shop, reason: `team ${team.name} already exists` });
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* Effect.sync(() => fixtureRows(data, now, () => crypto.randomUUID()));
    const work = yield* actors.addFixture(shop, rows.actor);
    const identity = yield* members.addToShop(shop, rows.identity);
    yield* actors.applyFixture(shop, rows.actor, "addToFixture");
    const counts: FixtureCounts = { members: identity.members, teams: identity.teams, ...work };
    yield* Effect.logInfo(
      `Fixtures.add: shop=${shop} members=${counts.members} teams=${counts.teams} workflows=${counts.workflows} orders=${counts.orders} lineItems=${counts.lineItems}`,
    );
    return counts;
  });

  return { load, add };
});

/**
 * Loading or adding a {@link ShopFixtureData} into one installed shop, over D1 and the shop's
 * actor.
 */
export class Fixtures extends Context.Service<Fixtures, Effect.Success<typeof make>>()(
  "app/Fixtures",
) {
  static readonly layer = Layer.effect(Fixtures, make);
}
