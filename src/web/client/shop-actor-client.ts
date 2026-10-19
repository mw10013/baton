import { createIsomorphicFn } from "@tanstack/react-start";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  applyCloseOutcome,
  closeOutcome,
  connectionStateAtom,
  merchantExpiredAtom,
  merchantTokenAtom,
  uninstalledAtom,
  reconnectAtom,
  retryPolicy,
  shopKeyAtom,
} from "./actor-connection.ts";
import type { SetTeamMemberInput } from "../../contract/members.ts";
import type { ShopKey } from "../../contract/shop.ts";
import type { ShopUsage } from "../../domain/billing.ts";
import {
  type Notice,
  NoticeFrame,
  ORDERS_KEY,
  SYNC_KEY,
  ShopActorRpcs,
} from "../../contract/shop-actor.ts";
import type {
  AssignRunTaskTeamInput,
  AttachWorkflowInput,
  BlockRunInput,
  ListOrdersInput,
  MarkTaskDoneInput,
  OrderCounts,
  OrderPageData,
  OrdersIndexData,
  PutBackTaskInput,
  ReopenTaskInput,
  RunIdInput,
  RunPageData,
  RunQuery,
  SetRunNoteInput,
  StartTaskInput,
  WorkflowsListData,
} from "../../domain/shop-work.ts";
import { LIVE_RETENTION } from "./query.ts";

/**
 * What {@link noticesAtom} hears: the actor's notices, and `Connected`, which the socket
 * publishes itself on every (re)connect, naming every key, because a notice sent while this
 * browser was disconnected is lost.
 */
export type BusNotice =
  | Notice
  | { readonly _tag: "Connected"; readonly invalidated: ReadonlyArray<string> };

/**
 * Notices pulled off the socket by {@link layerSocketWithNotices}, and the socket's
 * `Connected`; one per registry, like the socket, so a test registry never sees another's. The
 * last one is replayed to a new subscriber: the first `Connected` is published while
 * {@link noticesAtom} may still be subscribing, and dropping it would leave a seeded read
 * unchecked until the next write.
 */
export const noticeBus = Atom.make(() =>
  Effect.runSync(PubSub.unbounded<BusNotice>({ replay: 1 })),
).pipe(Atom.keepAlive);

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/**
 * The RPC socket with the actor's notice frames taken out: a frame that decodes as
 * {@link Notice} is published to {@link notices} and never reaches the RPC protocol, so the
 * protocol sees only its own messages. Pull again when a chunk held nothing else, because a
 * reader's pull must return a non-empty array.
 */
const layerSocketWithNotices = (url: Effect.Effect<string>, notices: PubSub.PubSub<BusNotice>) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      const inner = yield* Socket.makeWebSocket(url);
      const pullFiltered = (pull: Socket.Reader["pull"]): Socket.Reader["pull"] =>
        Effect.gen(function* () {
          while (true) {
            const rest: Array<Uint8Array | string> = [];
            for (const frame of yield* pull) {
              const notice = typeof frame === "string" ? decodeNotice(frame) : Option.none();
              if (Option.isSome(notice)) yield* PubSub.publish(notices, notice.value);
              else rest.push(frame);
            }
            if (Arr.isArrayNonEmpty(rest)) return rest;
          }
        });
      return Socket.make({
        writer: inner.writer,
        reader: Effect.map(inner.reader, (reader) => ({
          ...reader,
          pull: pullFiltered(reader.pull),
        })),
      });
    }),
  );

/** This page's origin as a WebSocket origin: `ws:` under `http:`, `wss:` under `https:`. */
const wsOrigin = () => {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

type ProtocolInput = {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly notices: PubSub.PubSub<BusNotice>;
  readonly key: ShopKey;
  readonly merchantToken: Option.Option<Effect.Effect<string>>;
};

/**
 * One hibernating WebSocket per browser, retried on `retryPolicy`, which stops on a terminal
 * close. The gate names the socket on its upgrade, from the cookie or, for a merchant, the
 * Shopify token on the URL (Baton's form), minted for each connect, so no call carries a
 * credential. Every close goes
 * through `closeOutcome` to the page's atoms.
 */
const browserProtocol = (input: ProtocolInput) => {
  const base = new URL(`/api/actor/${input.key}`, wsOrigin());
  const merchant = Option.isSome(input.merchantToken);
  const url = Option.match(input.merchantToken, {
    onNone: () => Effect.succeed(base.toString()),
    onSome: (mint) =>
      Effect.map(mint, (token) => {
        const withToken = new URL(base);
        withToken.searchParams.set("token", token);
        return withToken.toString();
      }),
  });
  const setState = (state: "connecting" | "open") =>
    Effect.sync(() => input.registry.set(connectionStateAtom, state));
  return Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryPolicy: retryPolicy((error) =>
        applyCloseOutcome(input.registry, closeOutcome(error, merchant)),
      ),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerSocketWithNotices(url, input.notices),
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: setState("open").pipe(
            Effect.andThen(
              PubSub.publish(input.notices, {
                _tag: "Connected",
                invalidated: [ORDERS_KEY, SYNC_KEY],
              }),
            ),
          ),
          onDisconnect: Effect.sync(() => {
            const state = input.registry.get(connectionStateAtom);
            if (state !== "displaced" && state !== "forbidden")
              input.registry.set(connectionStateAtom, "lost");
          }),
        }),
      ),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.tap(() => setState("connecting")),
  );
};

/**
 * Browser: {@link browserProtocol}. The server never reads a socket atom: a shop page renders
 * its loader's snapshot until it is hydrated, and the holder and the page fill the atoms in the
 * browser.
 */
const protocol = createIsomorphicFn()
  .client((input: ProtocolInput) => browserProtocol(input))
  .server((_input: ProtocolInput) =>
    Layer.effect(
      RpcClient.Protocol,
      Effect.die(new Error("the actor socket's atoms are never read on the server")),
    ),
  );

/** A socket atom read before the socket holder named the shop: a broken invariant. */
const unnamedShop = Layer.effect(
  RpcClient.Protocol,
  Effect.die(new Error("a socket atom was read before the socket holder named the shop")),
);

/**
 * The actor's procedures as atoms. The protocol reads {@link shopKeyAtom}, `merchantTokenAtom`
 * and `reconnectAtom`, so a change to any of them rebuilds the client and, in the browser,
 * reconnects.
 */
export class ShopActorClient extends AtomRpc.Service<ShopActorClient>()("ShopActorClient", {
  group: ShopActorRpcs,
  protocol: (get) => {
    get(reconnectAtom);
    return Option.match(get(shopKeyAtom), {
      onNone: () => unnamedShop,
      onSome: (key) =>
        protocol({
          registry: get.registry,
          notices: get(noticeBus),
          key,
          merchantToken: get(merchantTokenAtom),
        }),
    });
  },
  makeEffect: RpcClient.make(ShopActorRpcs, { flatten: true }),
}) {}

/** The notice keys each live query answers to, by query atom ({@link liveQuery}). */
const liveKeys = new WeakMap<Atom.Atom<any>, ReadonlyArray<string>>();

/**
 * A live read: `query` kept {@link LIVE_RETENTION} after its page stops showing it, and refetched
 * on a notice naming one of `keys` only while a page shows it. The wrapper reads `query` as a
 * tracked dependency, so `query` is observed exactly while the wrapper is mounted, and a notice
 * refreshes `query` itself ({@link refreshLive}): Atom refetches an observed node at once and
 * leaves an unobserved one stale, to refetch once when it is next read, its old value shown as
 * `waiting` meanwhile. A seeded node is valid with no build, which is why the keys live beside the
 * atom and not in a registration made by its build. `Atom.setIdleTTL` comes last, so the whole
 * chain is kept.
 *
 * Nothing here copies a value with `get.subscribe` and `get.once` (as `Atom.withReactivity`
 * does), so an interrupted refetch is always a stale node, never a `waiting` value with nothing
 * in flight.
 *
 * @see https://github.com/effect-app/libs `packages/vue/src/atomQuery.ts` (`buildQueryFamily`) and `queryLifetime.ts` (`atomsToRefetch`)
 */
export const liveQuery = <A, E>(
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  keys: ReadonlyArray<string>,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> => {
  liveKeys.set(query, keys);
  return Atom.transform(query, (get) => get(query), { initialValueTarget: query }).pipe(
    Atom.setIdleTTL(LIVE_RETENTION),
  );
};

/**
 * Refreshes every kept live query ({@link liveQuery}) whose keys meet `keys`, each once however
 * many of its keys a notice names: a second refresh would interrupt the first one's read.
 */
export const refreshLive = (registry: AtomRegistry.AtomRegistry, keys: ReadonlyArray<string>) => {
  for (const node of liveNodes(registry, keys)) registry.refresh(node.atom);
};

/** The kept live queries' nodes whose keys meet `keys` ({@link liveQuery}). */
const liveNodes = (registry: AtomRegistry.AtomRegistry, keys: ReadonlyArray<string>) =>
  Array.from(registry.getNodes().values()).filter((node) =>
    (liveKeys.get(node.atom) ?? []).some((key) => keys.includes(key)),
  );

/**
 * Fills a query atom's node with a value the page already has, as if the query had answered.
 * The registry consumes the value when it first creates the node; a node that is already
 * there (a page left less than its idle TTL ago) is refetched instead.
 */
const seed = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  value: A,
) => {
  if (!Atom.isSerializable(atom)) throw new Error("only a query with a serializationKey is seeded");
  const { key, encode } = atom[Atom.SerializableTypeId];
  if (registry.getNodes().has(key)) registry.refresh(atom);
  else registry.setSerializable(key, encode(AsyncResult.success(value)));
};

/**
 * Names the shop and credential the protocol connects with, and starts the connection state
 * afresh. Only the socket holder (`ShopSocket`, in the layout) runs it, once per shop and
 * credential, in the browser, before anything reads a socket atom; a page never does.
 */
export const nameSocket = (
  registry: AtomRegistry.AtomRegistry,
  key: ShopKey,
  merchantToken: Option.Option<Effect.Effect<string>>,
) => {
  registry.set(shopKeyAtom, Option.some(key));
  registry.set(merchantTokenAtom, merchantToken);
  registry.set(merchantExpiredAtom, false);
  registry.set(uninstalledAtom, false);
  registry.set(connectionStateAtom, "connecting");
};

/** How many orders a page of the orders index shows: the index's 25 rows. */
export const ORDERS_PAGE_SIZE = 25;

/**
 * The orders index's `listOrders` input for its URL: the page size, then the page, the search
 * and the filters as the URL has them, `null` for each key the URL leaves out.
 */
export const ordersIndexInput = (keys: {
  readonly after: ListOrdersInput["cursor"];
  readonly q: ListOrdersInput["q"];
  readonly show: ListOrdersInput["show"];
  readonly team: ListOrdersInput["team"];
}): ListOrdersInput => ({
  limit: ORDERS_PAGE_SIZE,
  cursor: keys.after,
  q: keys.q,
  show: keys.show,
  team: keys.team,
});

/**
 * **The orders index on arrival and the home page read the same `listOrders` input**:
 * {@link ordersIndexInput} with every key left out, one page of {@link ORDERS_PAGE_SIZE}, no
 * cursor, no search, no Show value (Making, the default) and no team. So the two share one entry
 * of the actor's orders memo (keyed by the input and cleared on every notice naming
 * {@link ORDERS_KEY}) and one node of {@link merchantOrdersAtom}. After a notice the first of them
 * to refetch pays the read and the other gets the entry. The home page takes only `page.counts`
 * from the answer; the page rows it discards were read for the memo entry anyway.
 */
export const ORDERS_ARRIVAL_INPUT: ListOrdersInput = ordersIndexInput({
  after: null,
  q: null,
  show: null,
  team: null,
});

/**
 * The orders strip, left to right, on the orders index and the home page: the four positions No
 * workflow, Not started, Making and Made in the order an order moves, then Issues, which cuts
 * across them. These are the five values `OrderCounts` counts; each cell is the value's name
 * (`ORDERS_SHOW_LABEL`) over its count. On the orders index choosing a cell sets the Show filter;
 * on the home page a cell links to the orders index with that value chosen. Making is the
 * default, `?show=` left out. Open, Unpaid, Fulfilled, Cancelled and All carry no count and live
 * in the Show select.
 */
export const ORDERS_STRIP: readonly (keyof OrderCounts)[] = [
  "no_workflow",
  "not_started",
  "making",
  "made",
  "issues",
];

/**
 * One page of the orders index, the query itself, by its whole input; the node
 * {@link seedOrders} fills. Each input is its own node under its own serialization key, so a
 * refetch on page two, or under a filter, reads that page.
 */
export const merchantOrdersQuery = Atom.family((input: ListOrdersInput) =>
  ShopActorClient.query("MerchantListOrders", input, {
    serializationKey: `merchant-orders:${JSON.stringify([input.limit, input.cursor, input.q, input.show, input.team])}`,
    timeToLive: LIVE_RETENTION,
  }),
);

/** One page of the orders index; live on {@link ORDERS_KEY}. */
export const merchantOrdersAtom = Atom.family((input: ListOrdersInput) =>
  liveQuery(merchantOrdersQuery(input), [ORDERS_KEY]),
);

/**
 * Whether an open-orders sync is running and the last one's error; live on {@link SYNC_KEY}. Not
 * seeded: the loader does not read it, so the banner and the button's state arrive with the
 * socket's first answer.
 */
export const merchantSyncStatusAtom = liveQuery(
  ShopActorClient.query("MerchantSyncStatus", undefined, {
    serializationKey: "merchant-sync-status",
    timeToLive: LIVE_RETENTION,
  }),
  [SYNC_KEY],
);

/**
 * The shop's usage (`ShopUsage`): the home page's meters and both pages' `QuotaBanners`; seeded
 * from the page's loader ({@link seedUsage}).
 */
export const merchantUsageQuery = ShopActorClient.query("MerchantGetUsage", undefined, {
  serializationKey: "merchant-usage",
  timeToLive: LIVE_RETENTION,
});

/**
 * {@link merchantUsageQuery}, live on {@link ORDERS_KEY} (a counted order, a refused one, a
 * billing cycle push) and {@link SYNC_KEY} (Sync open orders clears the ceiling's flag).
 */
export const merchantUsageAtom = liveQuery(merchantUsageQuery, [ORDERS_KEY, SYNC_KEY]);

/** Sync open orders: the screen's one button, so one mutation atom. */
export const syncOpenOrdersAtom = ShopActorClient.mutation("MerchantSyncOpenOrders");

/**
 * Sync from Shopify on one order, one atom per order id, each row's loading state its own.
 * `ShopActorClient.mutation` is one atom per procedure, and a second call re-runs it and
 * interrupts the first (its body is a `runtime.fn` without `concurrent`); the interrupt reaches
 * the actor and stops that order's sync, so pressing two rows would sync one. This is AtomRpc's
 * own mutation body, keyed on the order.
 *
 * @see refs/effect/packages/effect/src/reactivity/AtomRpc.ts (`mutation`)
 * @see refs/effect/packages/effect/src/reactivity/Atom.ts (`makeResultFn`)
 */
export const syncOrderAtom = Atom.family((orderId: string) =>
  ShopActorClient.runtime.fn<void>()(
    Effect.fnUntraced(function* () {
      const client = yield* ShopActorClient;
      return yield* client("MerchantSyncOrder", { orderId });
    }),
  ),
);

/** Add member, on the members index: one button, so one mutation atom. */
export const addMemberAtom = ShopActorClient.mutation("MerchantAddMember");

/** Delete member, on the member page. */
export const deleteMemberAtom = ShopActorClient.mutation("MerchantDeleteMember");

/** Add to teams, on the member page. */
export const addMemberTeamsAtom = ShopActorClient.mutation("MerchantAddMemberTeams");

/** Create team, on the teams index. */
export const createTeamAtom = ShopActorClient.mutation("MerchantCreateTeam");

/** Rename, on the team page. */
export const renameTeamAtom = ShopActorClient.mutation("MerchantRenameTeam");

/** Add members, on the team page. */
export const addTeamMembersAtom = ShopActorClient.mutation("MerchantAddTeamMembers");

/** Delete team, on the team page. */
export const deleteTeamAtom = ShopActorClient.mutation("MerchantDeleteTeam");

/** Create workflow, on the workflows index. */
export const createWorkflowAtom = ShopActorClient.mutation("MerchantCreateWorkflow");

/** Duplicate, on the workflow page. */
export const duplicateWorkflowAtom = ShopActorClient.mutation("MerchantDuplicateWorkflow");

/** Rename, on the workflow page and in the editor. */
export const updateWorkflowAtom = ShopActorClient.mutation("MerchantUpdateWorkflow");

/** Edit tag, on the workflow page. */
export const updateWorkflowTagAtom = ShopActorClient.mutation("MerchantUpdateWorkflowTag");

/** Apply changes, in the editor. */
export const applyDraftAtom = ShopActorClient.mutation("MerchantApplyDraft");

/** Discard changes, in the editor. */
export const discardDraftAtom = ShopActorClient.mutation("MerchantDiscardDraft");

/** The switch's Turn on and Turn off, on the workflow page and in the editor. */
export const setWorkflowStateAtom = ShopActorClient.mutation("MerchantSetWorkflowState");

/** The editor's Turn on for a workflow never applied. */
export const applyAndTurnOnAtom = ShopActorClient.mutation("MerchantApplyAndTurnOn");

/** Delete, on the workflow page and in the editor. */
export const deleteWorkflowAtom = ShopActorClient.mutation("MerchantDeleteWorkflow");

/** Add step, in the editor. */
export const addStepAtom = ShopActorClient.mutation("MerchantAddStep");

/** Add task to a step, in the editor. */
export const addTaskAtom = ShopActorClient.mutation("MerchantAddTask");

/** The task panel's Save, in the editor. */
export const updateTaskAtom = ShopActorClient.mutation("MerchantUpdateTask");

/** Move earlier and Move later, in the editor's task panel. */
export const moveTaskAtom = ShopActorClient.mutation("MerchantMoveTask");

/** Move to its own step, in the editor's task panel. */
export const separateTaskAtom = ShopActorClient.mutation("MerchantSeparateTask");

/** Join the previous step, in the editor's task panel. */
export const joinTaskAtom = ShopActorClient.mutation("MerchantJoinTask");

/** The task panel's Delete, in the editor. */
export const removeTaskAtom = ShopActorClient.mutation("MerchantRemoveTask");

/**
 * Remove on one row: a member's team row on the member page, a team's member row on the team
 * page, one atom per `<teamId>/<memberId>` pair, for {@link syncOrderAtom}'s reason (a second
 * press on one mutation atom would interrupt the first).
 */
export const setTeamMemberAtom = Atom.family((_pair: string) =>
  ShopActorClient.runtime.fn<SetTeamMemberInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantSetTeamMember", input);
    }),
  ),
);

/** The order page, by its `legacyId`; the node {@link seedOrderDetail} fills. */
export const merchantOrderDetailQuery = Atom.family((legacyId: string) =>
  ShopActorClient.query(
    "MerchantGetOrderDetail",
    { legacyId },
    { serializationKey: `merchant-order:${legacyId}`, timeToLive: LIVE_RETENTION },
  ),
);

/**
 * The order page, live on {@link ORDERS_KEY}: an order or one of its runs changed; see
 * {@link merchantOrderDetailQuery}.
 */
export const merchantOrderDetailAtom = Atom.family((legacyId: string) =>
  liveQuery(merchantOrderDetailQuery(legacyId), [ORDERS_KEY]),
);

/** Seeds the order page's node from the loader, as {@link seedOrders} does the orders index's. */
export const seedOrderDetail = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly legacyId: string; readonly data: OrderPageData | null },
) => seed(registry, merchantOrderDetailQuery(input.legacyId), input.data);

/**
 * The member's workflows list, by its whole query; the node {@link seedWorkflowsList} fills.
 * The member is the socket's caller, never the payload.
 */
export const memberRunsQuery = Atom.family((query: RunQuery) =>
  ShopActorClient.query(
    "MemberListRuns",
    { query },
    {
      serializationKey: `member-runs:${JSON.stringify([query.state, query.team, query.limit, query.q])}`,
      timeToLive: LIVE_RETENTION,
    },
  ),
);

/** The member's workflows list, live on {@link ORDERS_KEY}; see {@link memberRunsQuery}. */
export const memberRunsAtom = Atom.family((query: RunQuery) =>
  liveQuery(memberRunsQuery(query), [ORDERS_KEY]),
);

/** Seeds the workflows list's node from the loader, for the query the loader resolved. */
export const seedWorkflowsList = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly query: RunQuery; readonly list: WorkflowsListData },
) => seed(registry, memberRunsQuery(input.query), input.list);

/** The member's workflow page, by run; the node {@link seedMemberRun} fills. */
export const memberRunQuery = Atom.family((runId: string) =>
  ShopActorClient.query(
    "MemberGetRun",
    { runId },
    { serializationKey: `member-run:${runId}`, timeToLive: LIVE_RETENTION },
  ),
);

/** The member's workflow page, live on {@link ORDERS_KEY}; see {@link memberRunQuery}. */
export const memberRunAtom = Atom.family((runId: string) =>
  liveQuery(memberRunQuery(runId), [ORDERS_KEY]),
);

/** Seeds the member's workflow page's node from the loader. */
export const seedMemberRun = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly runId: string; readonly page: RunPageData | null },
) => seed(registry, memberRunQuery(input.runId), input.page);

/** Attach or Change workflow on the order page, one atom per item (`lineItemId`), for {@link syncOrderAtom}'s reason. */
export const attachWorkflowAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<AttachWorkflowInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantAttachWorkflow", input);
    }),
  ),
);

/** Cancel workflow on the order page, one atom per run. */
export const cancelRunAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<RunIdInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantCancelRun", input);
    }),
  ),
);

/** The merchant's Done, one atom per task. */
export const merchantMarkTaskDoneAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<MarkTaskDoneInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantMarkTaskDone", input);
    }),
  ),
);

/** The merchant's Reopen, one atom per task. */
export const merchantReopenTaskAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<ReopenTaskInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantReopenTask", input);
    }),
  ),
);

/** The merchant's Put back, one atom per task. */
export const merchantPutBackTaskAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<PutBackTaskInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantPutBackTask", input);
    }),
  ),
);

/** The merchant's note on a run, one atom per run. */
export const merchantSetRunNoteAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<SetRunNoteInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantSetRunNote", input);
    }),
  ),
);

/** The merchant's Block, one atom per run. */
export const merchantBlockRunAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<BlockRunInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantBlockRun", input);
    }),
  ),
);

/** The merchant's Unblock, one atom per run. */
export const merchantUnblockRunAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<RunIdInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantUnblockRun", input);
    }),
  ),
);

/** Assign team on the order page, one atom per task. */
export const assignRunTaskTeamAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<AssignRunTaskTeamInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MerchantAssignRunTaskTeam", input);
    }),
  ),
);

/** The member's Start, one atom per task. */
export const memberStartTaskAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<StartTaskInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberStartTask", input);
    }),
  ),
);

/** The member's Done, one atom per task. */
export const memberMarkTaskDoneAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<MarkTaskDoneInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberMarkTaskDone", input);
    }),
  ),
);

/** The member's Undo, one atom per task. */
export const memberReopenTaskAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<ReopenTaskInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberReopenTask", input);
    }),
  ),
);

/** The member's Put back, one atom per task. */
export const memberPutBackTaskAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<PutBackTaskInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberPutBackTask", input);
    }),
  ),
);

/** The member's note on a run, one atom per run. */
export const memberSetRunNoteAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<SetRunNoteInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberSetRunNote", input);
    }),
  ),
);

/** The member's Block, one atom per run. */
export const memberBlockRunAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<BlockRunInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberBlockRun", input);
    }),
  ),
);

/** The member's Unblock, one atom per run. */
export const memberUnblockRunAtom = Atom.family((_key: string) =>
  ShopActorClient.runtime.fn<RunIdInput>()(
    Effect.fnUntraced(function* (input) {
      const client = yield* ShopActorClient;
      return yield* client("MemberUnblockRun", input);
    }),
  ),
);

/**
 * Seeds one page of the merchant orders screen from the loader, so the table shows at once and
 * the socket only keeps it current. Run it for each page the screen shows, before the screen
 * reads that page's atom. A second run on the same registry (React's StrictMode doubles a state
 * initializer in development, and a page shown again within the idle TTL) finds the node and
 * refetches instead, which costs one round trip and nothing else.
 */
/** Seeds {@link merchantUsageQuery} with the usage a loader read. */
export const seedUsage = (registry: AtomRegistry.AtomRegistry, usage: ShopUsage) =>
  seed(registry, merchantUsageQuery, usage);

export const seedOrders = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly input: ListOrdersInput; readonly data: OrdersIndexData },
) => seed(registry, merchantOrdersQuery(input.input), input.data);

/**
 * How long a notice key's window lasts: the first notice for a key refreshes at once and opens
 * it; any more inside it cost one refresh when it ends, which opens the next. A burst of webhooks
 * then costs two reads of each shown page, not one per notice, and the last state is still read.
 * The first refresh is also what lets every tab of a shop join one memo entry in the actor: each
 * arrives one round trip after the notice that cleared it.
 *
 * @see refs/baton-legacy/src/lib/useLiveQuery.ts (`INVALIDATION_THROTTLE_MS`)
 */
export const NOTICE_THROTTLE = Duration.seconds(2);

/** Whether the tab is hidden (the Page Visibility API's `document.visibilityState`). */
const tabIsHidden = () => document.visibilityState === "hidden";

/**
 * {@link refreshLive}, except that a node whose read is in flight is not interrupted: it is
 * refreshed once when that read settles. An interrupt would reach the actor after its SQL may
 * have run, and the read in flight may already predate the notice, so it is replayed, not
 * dropped. `pending` holds the nodes waiting to be replayed, so a second notice adds nothing.
 *
 * @see https://github.com/effect-app/libs `packages/vue/src/liveQueryInvalidation.ts` (`beginLiveQueryFetch`, `endLiveQueryFetch`)
 */
const refreshLiveAfterReads = (
  registry: AtomRegistry.AtomRegistry,
  pending: Set<Atom.Atom<any>>,
  keys: ReadonlyArray<string>,
) => {
  for (const node of liveNodes(registry, keys)) {
    const atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> = node.atom;
    // Only a valid node is read here: reading a stale one would build it, which is a fetch.
    const reading = node.currentState() === "valid" && AsyncResult.isWaiting(node.value());
    if (!reading) {
      registry.refresh(atom);
      continue;
    }
    if (pending.has(atom)) continue;
    pending.add(atom);
    const stop = registry.subscribe(atom, (result) => {
      if (AsyncResult.isWaiting(result)) return;
      stop();
      pending.delete(atom);
      registry.refresh(atom);
    });
  }
};

/**
 * Notices, per registry, as legacy's `useLiveQuery` takes invalidations: each key is throttled
 * over {@link NOTICE_THROTTLE}, leading and trailing; while the tab is hidden its keys are held,
 * and released through the throttle on the next `visibilitychange` to visible, so a background
 * tab reads nothing for a screen nobody is looking at. `Connected` is neither throttled nor held:
 * it is rare, and whatever is shown may be stale by however long the socket was down. Every
 * refresh goes through {@link refreshLiveAfterReads}. Windows that end together refresh together,
 * so a node under two keys is refreshed once.
 *
 * @see refs/baton-legacy/src/lib/useLiveQuery.ts (`useLiveQuery`)
 */
const makeNoticeDispatch = (registry: AtomRegistry.AtomRegistry) => {
  const pending = new Set<Atom.Atom<any>>();
  /** Each open window's end, and whether a notice came in during it. */
  const windows = new Map<string, { readonly until: number; trailing: boolean }>();
  const held = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (keys: ReadonlyArray<string>) => {
    if (keys.length > 0) refreshLiveAfterReads(registry, pending, keys);
  };
  const open = (key: string, now: number) => {
    windows.set(key, { until: now + Duration.toMillis(NOTICE_THROTTLE), trailing: false });
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const ends = Array.from(windows.values(), ({ until }) => until);
    if (ends.length > 0) timer = setTimeout(close, Math.max(0, Math.min(...ends) - Date.now()));
  };
  const close = () => {
    timer = undefined;
    const now = Date.now();
    const due: string[] = [];
    for (const [key, window] of windows) {
      if (window.until > now) continue;
      windows.delete(key);
      if (!window.trailing) continue;
      if (tabIsHidden()) held.add(key);
      else {
        due.push(key);
        open(key, now);
      }
    }
    refresh(due);
    schedule();
  };
  const throttled = (keys: ReadonlyArray<string>) => {
    const now = Date.now();
    const lead: string[] = [];
    for (const key of keys) {
      const window = windows.get(key);
      if (window !== undefined) window.trailing = true;
      else {
        lead.push(key);
        open(key, now);
      }
    }
    refresh(lead);
    schedule();
  };
  const onVisibilityChange = () => {
    if (tabIsHidden() || held.size === 0) return;
    const keys = [...held];
    held.clear();
    throttled(keys);
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return {
    notice: (notice: BusNotice) =>
      Match.valueTags(notice, {
        Connected: ({ invalidated }) => refresh(invalidated),
        ShopActorNotice: ({ invalidated }) => {
          if (!tabIsHidden()) throttled(invalidated);
          else for (const key of invalidated) held.add(key);
        },
      }),
    dispose: () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
};

/**
 * Turns notices into refreshes of the live reads they name ({@link makeNoticeDispatch});
 * mounted by the socket holder for as long as the layout is, which is also what keeps the
 * client's runtime, and so the socket, alive. Browser only, as the holder is. The stream never
 * ends. It sees the last notice published before it subscribed (see {@link noticeBus}), so every
 * connect, the first included, refetches what the page shows.
 */
export const noticesAtom = ShopActorClient.runtime.atom((get) => {
  const dispatch = makeNoticeDispatch(get.registry);
  get.addFinalizer(dispatch.dispose);
  return Stream.fromPubSub(get(noticeBus)).pipe(
    Stream.tap((notice) => Effect.sync(() => dispatch.notice(notice))),
  );
});
