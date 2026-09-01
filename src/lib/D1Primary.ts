import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer } from "effect";
import { Reactivity } from "effect/unstable/reactivity";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

/**
 * A `D1Client` bound to the raw `env.D1` binding, which always talks to the
 * **primary database instance** — D1 read replicas only exist inside the
 * Sessions API, so this client can never serve a stale read. `D1Session` wraps
 * the per-request replica session instead; use this service for
 * correctness-sensitive paths where a stale read causes wrong decisions
 * (membership writes, the magic-link sign-in gate) and for their paired reads.
 * Writes through this client bypass the session, so they do NOT advance the
 * session bookmark — pair them with primary reads, not session reads.
 * `D1Client.make` is the public constructor the library's own `layer` uses,
 * needing only `Scope` + `Reactivity`. `Reactivity.layer` only satisfies that
 * mandatory dependency (see `D1Session` for why it is inert here).
 */
export class D1Primary extends Context.Service<D1Primary, D1Client.D1Client>()(
  "D1Primary",
) {
  static readonly layerNoDeps: Layer.Layer<D1Primary, never, Env> =
    Layer.effect(
      D1Primary,
      Effect.gen(function* () {
        const { D1: db } = yield* CloudflareEnv;
        return yield* D1Client.make({ db });
      }),
    ).pipe(Layer.provide(Reactivity.layer));
}
