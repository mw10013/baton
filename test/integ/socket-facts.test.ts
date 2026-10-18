import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/contract/shop.ts";
import { CONNECTION_CLOSE_REVOKED, type MemberCaller } from "../../src/contract/shop-actor.ts";
import * as ShopWork from "../../src/domain/shop-work.ts";
import {
  addToFixture,
  connectAs,
  dev,
  email,
  nextCloseCode,
  openAs,
  signIn,
} from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The platform facts the actor's socket identity rests on, proved in workerd: the identity and
 * tags a socket is accepted with survive Alchemy's own attachment writes and a hibernation, the
 * identity reaches the RPC middleware on every message, and a socket closed before its message
 * is dispatched leaves Alchemy's transport and the object clean.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("socketfacts"),
});

/** A fresh stage per file, destroyed afterwards; see the same declaration in `auth.test.ts`. */
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** A seeded shop of its own, so no other file shares its actor. */
const key = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");

/** One page of Ready, every team. */
const READY = Schema.decodeUnknownSync(ShopWork.RunQuery)({
  team: null,
  state: "ready",
  limit: ShopWork.RUN_PAGE,
  q: null,
});

/** A run id no run has. */
const missingRun = Schema.decodeUnknownSync(ShopWork.RunIdInput)({ runId: "no-such-run" }).runId;

/** A member identity no sign-in produces, for the test Backend's forged-caller route. */
const memberAs = (memberId: string, sessionExpiresAt: number): MemberCaller => ({
  role: "member",
  memberId,
  memberEmail: email(`${memberId}@e2e.test`),
  teamIds: [],
  userId: `user-${memberId}`,
  sessionId: `session-${memberId}`,
  sessionExpiresAt,
});

test(
  "a socket's identity and tags survive Alchemy's writes and a hibernation",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const address = email("facts-hibernate@e2e.test");
    yield* addToFixture(backendUrl, key, { members: [address] });
    const cookie = yield* signIn(backendUrl, address);
    yield* Effect.gen(function* () {
      const a = yield* connectAs(backendUrl, key, { cookie });
      // Every call goes through the middleware that dies without the socket's identity.
      const caller = yield* a.client.MemberWhoAmI();
      assert.strictEqual(caller.role === "member" && caller.memberEmail, address);
      const first = yield* a.client.MemberActivation();
      // Each call is an event that keeps the object awake, and local workerd evicts an idle
      // one after about 10 s, so the polls are spaced wider than that. The clients' pings are
      // answered by the auto-response and do not wake it.
      const later = yield* a.client.MemberActivation().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("12 seconds"),
          until: (activation) => activation.id !== first.id,
          times: 5,
        }),
      );
      assert.notStrictEqual(later.id, first.id, "the actor hibernated");
      assert.deepStrictEqual(yield* a.client.MemberWhoAmI(), caller, "the attachment survived");
      // A revoke selects sockets by the `member:<id>` tag, so a close proves the tag survived.
      const removed = yield* dev(backendUrl, (c) => c.RemoveMember({ shop: key, email: address }));
      assert.deepStrictEqual(removed, { removed: true, closed: 1 });
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
  { timeout: 90_000 },
);

test(
  "a socket closed before its message is dispatched leaves the transport and the object clean",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const b = yield* openAs(backendUrl, key, memberAs("facts-b", Date.now() + 600_000));
      const before = yield* b.client.MemberActivation();

      const a = yield* openAs(backendUrl, key, memberAs("facts-a", Date.now() - 1));
      // The message is never dispatched, so the call has no answer; only the close arrives.
      yield* a.client.MemberWhoAmI().pipe(Effect.forkScoped);
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);

      // A read and a write, both dispatched: the write's run is none of b's, so it answers.
      const list = yield* b.client.MemberListRuns({ query: READY });
      assert.strictEqual(list.counts.ready, 0);
      const noted = yield* b.client.MemberSetRunNote({ runId: missingRun, note: null });
      assert.deepStrictEqual(noted, { _tag: "NotFound" });
      assert.strictEqual((yield* b.client.MemberActivation()).id, before.id, "no reset");
      const c = yield* openAs(backendUrl, key, memberAs("facts-c", Date.now() + 600_000));
      assert.strictEqual(
        (yield* c.client.MemberActivation()).id,
        before.id,
        "a new socket is served",
      );
    }).pipe(Effect.scoped);
  }),
);
