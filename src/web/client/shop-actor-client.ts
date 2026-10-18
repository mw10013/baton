import { createIsomorphicFn } from "@tanstack/react-start";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import * as Reactivity from "effect/reactivity/Reactivity";
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
  notAMemberAtom,
  uninstalledAtom,
  reconnectAtom,
  retryPolicy,
  shopKeyAtom,
} from "./actor-connection.ts";
import type { SetTeamMemberInput } from "../../contract/members.ts";
import type { ShopKey } from "../../contract/shop.ts";
import {
  COUNT_KEY,
  type ConnectionCaller,
  type Notice,
  NoticeFrame,
  ORDERS_KEY,
  SYNC_KEY,
  ShopActorRpcs,
  type ShopSnapshot,
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
import { refreshOnFocus } from "./query.ts";

/**
 * Notices pulled off the socket by {@link layerSocketWithNotices}; one per registry, like the
 * socket, so a test registry never sees another's. The last one is replayed to a new
 * subscriber: the first connect's refresh notice is published while {@link noticesAtom} may
 * still be subscribing, and dropping it would leave the seeded count unchecked until the next
 * write.
 */
export const noticeBus = Atom.make(() =>
  Effect.runSync(PubSub.unbounded<Notice>({ replay: 1 })),
).pipe(Atom.keepAlive);

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/**
 * The RPC socket with the actor's notice frames taken out: a frame that decodes as
 * {@link Notice} is published to {@link notices} and never reaches the RPC protocol, so the
 * protocol sees only its own messages. Pull again when a chunk held nothing else, because a
 * reader's pull must return a non-empty array.
 */
const layerSocketWithNotices = (url: Effect.Effect<string>, notices: PubSub.PubSub<Notice>) =>
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
  readonly notices: PubSub.PubSub<Notice>;
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
        // Refetch after every (re)connect: a notice sent while this browser was disconnected
        // is lost.
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: setState("open").pipe(
            Effect.andThen(
              PubSub.publish(input.notices, {
                _tag: "ShopActorNotice",
                invalidated: [COUNT_KEY, ORDERS_KEY, SYNC_KEY],
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

/**
 * The member's count query itself, without the wrappers {@link countAtom} adds: the node
 * {@link seedShop} fills.
 */
export const countQuery = ShopActorClient.query("MemberGetCount", undefined, {
  serializationKey: "count",
});

/** The shop's count for a member; refetched on every notice naming {@link COUNT_KEY}. */
export const countAtom = countQuery.pipe(Atom.withReactivity([COUNT_KEY]), refreshOnFocus);

/** The merchant's count query; see {@link countQuery}. */
export const merchantCountQuery = ShopActorClient.query("MerchantGetCount", undefined, {
  serializationKey: "merchant-count",
});

/** The shop's count for a merchant; see {@link countAtom}. */
export const merchantCountAtom = merchantCountQuery.pipe(
  Atom.withReactivity([COUNT_KEY]),
  refreshOnFocus,
);

export const incrementAtom = ShopActorClient.mutation("MemberIncrement");

export const resetCountAtom = ShopActorClient.mutation("MerchantResetCount");

export const activationAtom = ShopActorClient.query("MemberActivation", undefined, {
  serializationKey: "activation",
});

/** Who the actor says this member is. */
export const whoAmIAtom = ShopActorClient.query("MemberWhoAmI", undefined, {
  serializationKey: "whoami",
});

/** Who the actor says this merchant is. */
export const merchantWhoAmIAtom = ShopActorClient.query("MerchantWhoAmI", undefined, {
  serializationKey: "merchant-whoami",
});

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
  registry.set(notAMemberAtom, false);
  registry.set(merchantExpiredAtom, false);
  registry.set(uninstalledAtom, false);
  registry.set(connectionStateAtom, "connecting");
};

/**
 * Seeds the socket's atoms from a shop page's loader data: the role's count, who-am-I and (for a
 * member) activation, so the page shows them at once and the socket only keeps them current.
 * Run it once, in the browser, under the socket holder that named the socket ({@link nameSocket})
 * and before the page reads any socket atom. A second run on the same registry (React's
 * StrictMode doubles a state initializer in development, and a page shown again within the idle
 * TTL) finds the nodes and refetches instead, which costs one round trip and nothing else.
 */
export const seedShop = (
  registry: AtomRegistry.AtomRegistry,
  input: {
    readonly role: ConnectionCaller["role"];
    readonly caller: ConnectionCaller;
    readonly snapshot: ShopSnapshot;
  },
) => {
  if (input.role === "merchant") {
    seed(registry, merchantCountQuery, input.snapshot.count);
    seed(registry, merchantWhoAmIAtom, input.caller);
  } else {
    seed(registry, countQuery, input.snapshot.count);
    seed(registry, whoAmIAtom, input.caller);
    seed(registry, activationAtom, input.snapshot.activation);
  }
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
  }),
);

/** One page of the orders index; refetched on every notice naming {@link ORDERS_KEY}. */
export const merchantOrdersAtom = Atom.family((input: ListOrdersInput) =>
  merchantOrdersQuery(input).pipe(Atom.withReactivity([ORDERS_KEY]), refreshOnFocus),
);

/**
 * Whether an open-orders sync is running and the last one's error; refetched on every notice
 * naming {@link SYNC_KEY}. Not seeded: the loader does not read it, so the banner and the
 * button's state arrive with the socket's first answer.
 */
export const merchantSyncStatusAtom = ShopActorClient.query("MerchantSyncStatus", undefined, {
  serializationKey: "merchant-sync-status",
}).pipe(Atom.withReactivity([SYNC_KEY]), refreshOnFocus);

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

/**
 * The order page, by its `legacyId`; the node {@link seedOrderDetail} fills. Refetched on every
 * notice naming {@link ORDERS_KEY}: an order or one of its runs changed.
 */
export const merchantOrderDetailQuery = Atom.family((legacyId: string) =>
  ShopActorClient.query(
    "MerchantGetOrderDetail",
    { legacyId },
    { serializationKey: `merchant-order:${legacyId}` },
  ),
);

/** The order page; see {@link merchantOrderDetailQuery}. */
export const merchantOrderDetailAtom = Atom.family((legacyId: string) =>
  merchantOrderDetailQuery(legacyId).pipe(Atom.withReactivity([ORDERS_KEY]), refreshOnFocus),
);

/** Seeds the order page's node from the loader, as {@link seedOrders} does the orders index's. */
export const seedOrderDetail = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly legacyId: string; readonly data: OrderPageData | null },
) => seed(registry, merchantOrderDetailQuery(input.legacyId), input.data);

/**
 * The member's workflows list, by its whole query; the node {@link seedWorkflowsList} fills.
 * The member is the socket's caller, never the payload. Refetched on every notice naming
 * {@link ORDERS_KEY}.
 */
export const memberRunsQuery = Atom.family((query: RunQuery) =>
  ShopActorClient.query(
    "MemberListRuns",
    { query },
    {
      serializationKey: `member-runs:${JSON.stringify([query.state, query.team, query.limit, query.q])}`,
    },
  ),
);

/** The member's workflows list; see {@link memberRunsQuery}. */
export const memberRunsAtom = Atom.family((query: RunQuery) =>
  memberRunsQuery(query).pipe(Atom.withReactivity([ORDERS_KEY]), refreshOnFocus),
);

/** Seeds the workflows list's node from the loader, for the query the loader resolved. */
export const seedWorkflowsList = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly query: RunQuery; readonly list: WorkflowsListData },
) => seed(registry, memberRunsQuery(input.query), input.list);

/** The member's workflow page, by run; the node {@link seedMemberRun} fills. */
export const memberRunQuery = Atom.family((runId: string) =>
  ShopActorClient.query("MemberGetRun", { runId }, { serializationKey: `member-run:${runId}` }),
);

/** The member's workflow page; see {@link memberRunQuery}. */
export const memberRunAtom = Atom.family((runId: string) =>
  memberRunQuery(runId).pipe(Atom.withReactivity([ORDERS_KEY]), refreshOnFocus),
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
 * reads that page's atom; the same rules as {@link seedShop}.
 */
export const seedOrders = (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly input: ListOrdersInput; readonly data: OrdersIndexData },
) => seed(registry, merchantOrdersQuery(input.input), input.data);

/**
 * Turns notices into invalidations; mounted by the socket holder for as long as the layout is,
 * which is also what keeps the client's runtime, and so the socket, alive. The stream never ends. It sees the
 * last notice published before it subscribed (see {@link noticeBus}), so every connect, the
 * first included, refetches what the page shows.
 */
export const noticesAtom = ShopActorClient.runtime.atom((get) =>
  Stream.fromPubSub(get(noticeBus)).pipe(
    Stream.tap((notice) => Reactivity.invalidate(notice.invalidated)),
  ),
);
