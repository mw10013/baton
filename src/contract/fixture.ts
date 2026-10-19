/**
 * A fixture: a known state one installed shop is put into, on demand, as opposed to the seed a
 * whole stage starts with. A {@link ShopFixture} names its data by value (team and workflow
 * names, member emails, order numbers), never by id, because every id is minted when it is
 * loaded. Its schemas hold every rule the data must keep, so a fixture that would break a table
 * constraint or a cross-reference fails to decode instead of failing halfway through a write.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LineItemProperty } from "../domain/orders.ts";
import { TaskInstructions, TaskName, TeamName, WorkflowState } from "../domain/shop-work.ts";
import { Email } from "./auth.ts";
import { ShopKey } from "../domain/platform.ts";

/**
 * The `legacyId` prefix of a fixture order: `fixture-<n>`, whose id is
 * `gid://shopify/Order/fixture-<n>`. A fixture order is never in Shopify, so nothing may sync it,
 * link to it in the Shopify admin, or ask Shopify about it; a real Shopify id is numeric and never
 * carries the prefix.
 */
export const FIXTURE_ORDER_PREFIX = "fixture-";

/** A fixture order's `legacyId`, `fixture-<n>`; see {@link FIXTURE_ORDER_PREFIX}. */
const FixtureLegacyId = Schema.TemplateLiteral([FIXTURE_ORDER_PREFIX, Schema.String]);

/** Whether an order's `legacyId` is a fixture order's, which the screen must not offer to Shopify. */
export const isFixtureOrder = Schema.is(FixtureLegacyId);

/** A name as the tables require it: non-empty, with no space at either end. */
const Name = Schema.Trimmed.check(Schema.isNonEmpty());

/** A count of something on an order: a positive whole number. */
const Quantity = Schema.Int.check(Schema.isGreaterThan(0));

/** An order line's quantity after an edit or a refund; 0 is an item removed. */
const CurrentQuantity = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A variant of a {@link Product}: the value of the product's one option, and its price. */
export const Variant = Schema.Struct({ value: Name, price: Schema.String });

/**
 * A product in the store. Its `handle` is its identity there, so writing the fixture again puts a
 * product back the way the fixture says. A variant's SKU is derived from `skuStem`; a product
 * with none has no SKUs.
 */
export const Product = Schema.Struct({
  handle: Name,
  title: Name,
  /** The name of the one product option; its values are the variants. */
  option: Name,
  variants: Schema.Array(Variant),
  skuStem: Schema.optionalKey(Name),
  /** Workflow tags, as workflows match them; empty for a product no workflow follows. */
  tags: Schema.Array(Name),
});
export type Product = typeof Product.Type;

/** A line of a {@link StoreOrder}: a product by handle and one of its option values. */
export const StoreOrderLine = Schema.Struct({
  handle: Name,
  value: Name,
  quantity: Quantity,
  /** What a customer would have typed into the product's line properties. */
  properties: Schema.Record(Schema.String, Schema.String),
});
export type StoreOrderLine = typeof StoreOrderLine.Type;

/** A real order the store keeps open, found again on a second write by its own `tag`. */
export const StoreOrder = Schema.Struct({
  tag: Name,
  lines: Schema.Array(StoreOrderLine),
});
export type StoreOrder = typeof StoreOrder.Type;

/**
 * A team, with which of the fixture's members are on it; an empty list is a team with nobody. The
 * name is a {@link TeamName}, so a fixture never stores a team the screens cannot decode.
 */
export const FixtureTeam = Schema.Struct({ name: TeamName, members: Schema.Array(Email) });
export type FixtureTeam = typeof FixtureTeam.Type;

/**
 * A workflow task. `team` names one of the fixture's teams, or is `null` for a task with no team.
 * A task with no `step` comes right after the previous one; tasks that share a step run in
 * parallel.
 */
export const FixtureTask = Schema.Struct({
  name: TaskName,
  team: Schema.NullOr(TeamName),
  step: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  instructions: Schema.optionalKey(TaskInstructions),
});
export type FixtureTask = typeof FixtureTask.Type;

export { WorkflowState };

/**
 * The step each task gets: its own, or the previous task's plus one (the first task's previous
 * is 0).
 */
export const stepsOf = (tasks: ReadonlyArray<FixtureTask>): ReadonlyArray<number> =>
  tasks.reduce<ReadonlyArray<number>>(
    (steps, task) => [...steps, task.step ?? (steps.at(-1) ?? 0) + 1],
    [],
  );

/** Steps are dense from 1 and non-decreasing along the list: each is the previous or one more. */
const stepsAreDense = (tasks: ReadonlyArray<FixtureTask>) =>
  stepsOf(tasks).every((step, index, steps) => {
    const previous = steps[index - 1] ?? 0;
    return index === 0 ? step === 1 : step === previous || step === previous + 1;
  });

/**
 * The state a workflow is stored with: its own, or else `active` when it has tasks and every task
 * has a team, which is the only state a workflow that creates runs can have.
 */
export const workflowStateOf = (workflow: {
  readonly state?: WorkflowState;
  readonly tasks: ReadonlyArray<FixtureTask>;
}): WorkflowState =>
  workflow.state ??
  (workflow.tasks.length > 0 && workflow.tasks.every((task) => task.team !== null)
    ? "active"
    : "inactive");

/**
 * A workflow. Its one `tag` is what a product carries to follow it; a tag has no comma, because
 * Shopify splits a typed product tag on commas. `draft` is a pending edit beside the workflow's
 * own tasks; the tag is not drafted. Steps must be dense from 1, the draft's included, and an
 * active workflow needs tasks, each with a team, as the workflow editor requires.
 */
export const FixtureWorkflow = Schema.Struct({
  name: Name,
  state: Schema.optionalKey(WorkflowState),
  tag: Name.check(Schema.isPattern(/^[^,]*$/u, { message: "A tag has no comma." })),
  tasks: Schema.Array(FixtureTask),
  draft: Schema.optionalKey(Schema.Struct({ tasks: Schema.Array(FixtureTask) })),
}).check(
  Schema.makeFilter((workflow) => {
    const issues: Array<Schema.FilterIssue> = [];
    if (!stepsAreDense(workflow.tasks))
      issues.push({ path: ["tasks"], issue: "Steps must be dense from 1 and non-decreasing." });
    if (workflow.draft !== undefined && !stepsAreDense(workflow.draft.tasks))
      issues.push({
        path: ["draft", "tasks"],
        issue: "Steps must be dense from 1 and non-decreasing.",
      });
    if (
      workflowStateOf(workflow) === "active" &&
      (workflow.tasks.length === 0 || workflow.tasks.some((task) => task.team === null))
    )
      issues.push({
        path: ["state"],
        issue: "An active workflow needs tasks, and every task needs a team.",
      });
    return issues;
  }),
);
export type FixtureWorkflow = typeof FixtureWorkflow.Type;

/**
 * Progress on a run, shared by an order and an item; see {@link FixtureProgress}. The actor
 * applies it after the fixture's rows and teams are in (`applyFixture`), in legacy's seed order.
 */
const progressFields = {
  /** Every task done. Exclusive with `advance`. */
  done: Schema.optionalKey(Schema.Boolean),
  /** That many rounds of current tasks done: each round finishes what was current when it began. */
  advance: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** After `advance`, start whatever is ready. */
  started: Schema.optionalKey(Schema.Boolean),
  /** After `advance`, block the run with this reason. */
  blocked: Schema.optionalKey(Name),
  /** The dones and the block are the merchant's; a start stays the member's. */
  byMerchant: Schema.optionalKey(Schema.Boolean),
  /** The member who starts, does or blocks; one of the fixture's members. */
  by: Schema.optionalKey(Email),
  /** Last, the merchant cancels the workflow on the item. */
  cancelled: Schema.optionalKey(Schema.Boolean),
};

/**
 * `done` runs first and leaves nothing current, so `advance` beside it would do nothing and the
 * data would read as something it is not.
 */
const doneAndAdvanceExclusive = Schema.makeFilter(
  (progress: { readonly done?: boolean; readonly advance?: number }) =>
    progress.done !== true || progress.advance === undefined || "done and advance are exclusive",
);

/** One item's progress: the shared keys and the run's note. */
export const FixtureProgress = Schema.Struct({
  ...progressFields,
  note: Schema.optionalKey(Name),
}).check(doneAndAdvanceExclusive);
export type FixtureProgress = typeof FixtureProgress.Type;

/**
 * A later change to an order, applied after its progress: cancelled, a new fulfillment status,
 * or new quantities for items named by 1-based position in the order's `lineItems`.
 */
export const FixtureOrderChange = Schema.Struct({
  cancelled: Schema.optionalKey(Schema.Boolean),
  fulfillmentStatus: Schema.optionalKey(Name),
  lineItems: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ position: Quantity, currentQuantity: Schema.optionalKey(CurrentQuantity) }),
    ),
  ),
});
export type FixtureOrderChange = typeof FixtureOrderChange.Type;

export { LineItemProperty };

/**
 * An item of a fixture order. `tags` are its product's tags, which workflows match on.
 * `currentQuantity` defaults to `quantity`. `progress` is this item's run alone, in place of the
 * order's own progress keys. `workflow` names one of the fixture's workflows, set on the item as
 * the merchant's choice.
 */
export const FixtureLineItem = Schema.Struct({
  title: Name,
  variantTitle: Schema.optionalKey(Schema.String),
  sku: Schema.optionalKey(Schema.String),
  quantity: Quantity,
  currentQuantity: Schema.optionalKey(CurrentQuantity),
  tags: Schema.Array(Schema.String),
  properties: Schema.Array(LineItemProperty).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  progress: Schema.optionalKey(FixtureProgress),
  workflow: Schema.optionalKey(Name),
});
export type FixtureLineItem = typeof FixtureLineItem.Type;

/**
 * Whole days before now that a fixture order was placed, under the year an order is kept, so no
 * fixture order is one a retention sweep would delete.
 */
export const PlacedDaysAgo = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(365),
);

/**
 * A fixture order: `n` is its number, `#n`. The progress keys apply to every item without a
 * `progress` of its own; `note` is the order note. `after` is a change that lands after the
 * work started, and its positions must name the order's items.
 */
export const FixtureOrder = Schema.Struct({
  n: Quantity,
  fulfillmentStatus: Schema.optionalKey(Name),
  unpaid: Schema.optionalKey(Schema.Boolean),
  placedDaysAgo: Schema.optionalKey(PlacedDaysAgo),
  ...progressFields,
  note: Schema.optionalKey(Schema.String),
  lineItems: Schema.Array(FixtureLineItem),
  after: Schema.optionalKey(FixtureOrderChange),
}).check(
  doneAndAdvanceExclusive,
  Schema.makeFilter((order) =>
    (order.after?.lineItems ?? []).every(({ position }) => position <= order.lineItems.length)
      ? undefined
      : { path: ["after", "lineItems"], issue: "A position names none of the order's items." },
  ),
);
export type FixtureOrder = typeof FixtureOrder.Type;

const dataFields = {
  members: Schema.Array(Email).check(Schema.isUnique()),
  teams: Schema.Array(FixtureTeam),
  workflows: Schema.Array(FixtureWorkflow),
  orders: Schema.Array(FixtureOrder),
};

/** The first value that occurs twice. */
const firstDuplicate = <A>(values: ReadonlyArray<A>) =>
  values.find((value, index) => values.indexOf(value) !== index);

/**
 * The references between the parts of a fixture, which no single field can check: unique team
 * names, workflow names, workflow tags and order numbers; every team member and every `by` a
 * fixture member; every task's team a fixture team; every item's workflow a fixture workflow.
 */
const referencesResolve = Schema.makeFilter(
  (data: {
    readonly members: ReadonlyArray<Email>;
    readonly teams: ReadonlyArray<FixtureTeam>;
    readonly workflows: ReadonlyArray<FixtureWorkflow>;
    readonly orders: ReadonlyArray<FixtureOrder>;
  }) => {
    const issues: Array<Schema.FilterIssue> = [];
    const members = new Set<string>(data.members);
    const teams = new Set(data.teams.map((team) => team.name));
    const workflows = new Set(data.workflows.map((workflow) => workflow.name));
    const unique = (path: string, what: string, values: ReadonlyArray<string | number>) => {
      const duplicate = firstDuplicate(values);
      if (duplicate !== undefined)
        issues.push({ path: [path], issue: `Two ${what} share ${String(duplicate)}.` });
    };
    unique(
      "teams",
      "teams",
      data.teams.map((team) => team.name),
    );
    unique(
      "workflows",
      "workflows",
      data.workflows.map((workflow) => workflow.name),
    );
    unique(
      "workflows",
      "workflows' tags",
      data.workflows.map((workflow) => workflow.tag),
    );
    unique(
      "orders",
      "orders",
      data.orders.map((order) => order.n),
    );
    data.teams.forEach((team, index) => {
      for (const email of team.members)
        if (!members.has(email))
          issues.push({
            path: ["teams", index, "members"],
            issue: `${email} is not a fixture member.`,
          });
    });
    data.workflows.forEach((workflow, index) => {
      for (const task of [...workflow.tasks, ...(workflow.draft?.tasks ?? [])])
        if (task.team !== null && !teams.has(task.team))
          issues.push({
            path: ["workflows", index, "tasks"],
            issue: `${task.team} is not a fixture team.`,
          });
    });
    data.orders.forEach((order, index) => {
      const bys = [order.by, ...order.lineItems.map((item) => item.progress?.by)];
      for (const by of bys)
        if (by !== undefined && !members.has(by))
          issues.push({ path: ["orders", index], issue: `${by} is not a fixture member.` });
      for (const item of order.lineItems)
        if (item.workflow !== undefined && !workflows.has(item.workflow))
          issues.push({
            path: ["orders", index, "lineItems"],
            issue: `${item.workflow} is not a fixture workflow.`,
          });
    });
    return issues;
  },
);

/**
 * The half of a {@link ShopFixture} the Backend loads: D1's members, teams and team members, and
 * the shop actor's workflows and orders.
 */
export const ShopFixtureData = Schema.Struct(dataFields).check(referencesResolve);
export type ShopFixtureData = typeof ShopFixtureData.Type;

/**
 * One shop's fixture: the store half (`products` and `storeOrders`, written into the store through
 * Shopify CLI) and {@link ShopFixtureData}. Every store order line names a fixture product and one
 * of its option values.
 */
export const ShopFixture = Schema.Struct({
  products: Schema.Array(Product),
  storeOrders: Schema.Array(StoreOrder),
  ...dataFields,
}).check(
  referencesResolve,
  Schema.makeFilter((fixture) => {
    const issues: Array<Schema.FilterIssue> = [];
    const handle = firstDuplicate(fixture.products.map((product) => product.handle));
    if (handle !== undefined)
      issues.push({ path: ["products"], issue: `Two products share ${handle}.` });
    const tag = firstDuplicate(fixture.storeOrders.map((order) => order.tag));
    if (tag !== undefined)
      issues.push({ path: ["storeOrders"], issue: `Two store orders share ${tag}.` });
    fixture.storeOrders.forEach((order, index) => {
      for (const line of order.lines) {
        const product = fixture.products.find((entry) => entry.handle === line.handle);
        if (product?.variants.some((variant) => variant.value === line.value) !== true)
          issues.push({
            path: ["storeOrders", index, "lines"],
            issue: `${line.handle} has no variant ${line.value}.`,
          });
      }
    });
    return issues;
  }),
);
export type ShopFixture = typeof ShopFixture.Type;

/** The shop has no `ShopSession`: the app was never opened in that store on this stage. */
export class ShopNotInstalled extends Schema.TaggedError<ShopNotInstalled>()("ShopNotInstalled", {
  shop: ShopKey,
}) {}

/**
 * A row `AddToFixture` would add is already in the shop: a member email, team name, workflow
 * name, workflow tag or order number, each unique in its table. Nothing was written.
 */
export class FixtureConflict extends Schema.TaggedError<FixtureConflict>()("FixtureConflict", {
  shop: ShopKey,
  reason: Schema.String,
}) {}

/**
 * What `LoadFixture` and `AddToFixture` answer: the shop's rows after the write, counted by the
 * stores that hold them, not echoed from the input.
 */
export const FixtureCounts = Schema.Struct({
  members: Schema.Int,
  teams: Schema.Int,
  workflows: Schema.Int,
  orders: Schema.Int,
  lineItems: Schema.Int,
});
export type FixtureCounts = typeof FixtureCounts.Type;
