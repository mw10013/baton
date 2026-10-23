import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Mailer } from "./mailer.ts";

/**
 * Where a stage's magic links go. `inline`: back to the caller that asked for one, which a
 * sign-in page shows and a test runner follows; no mail is sent. `mailed`: to the address's
 * inbox, and nothing in-process can read it. A stage is one or the other, never both: a link
 * that went to an inbox is not held anywhere.
 */
export const DeliveryMode = Config.Literals(["inline", "mailed"], "MAGIC_LINK_DELIVERY");
export type DeliveryMode = Config.Success<typeof DeliveryMode>;

const mail = (url: string) => {
  const href = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return {
    subject: "Sign in to Baton",
    text: `Sign in to Baton: ${url}\n\nThis link expires in 5 minutes. If you did not ask for it, ignore this email.`,
    html: `<p>Sign in to Baton.</p><p><a href="${href}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Sign in to Baton</a></p><p>If the button does not work, copy this link into your browser:<br>${href}</p><p>This link expires in 5 minutes. If you did not ask for it, ignore this email.</p>`,
  };
};

/**
 * Delivers the magic links Better Auth makes, in the stage's {@link DeliveryMode}. `take`
 * returns the last link delivered inline to an address, once; under mailed delivery it is
 * always none, so a caller that needs the link learns the stage cannot give it.
 */
export class MagicLinkDelivery extends Context.Service<
  MagicLinkDelivery,
  {
    readonly deliver: (to: string, url: string) => Effect.Effect<void>;
    readonly take: (to: string) => Effect.Effect<Option.Option<string>>;
  }
>()("app/MagicLinkDelivery") {
  static readonly layerInline = Layer.sync(MagicLinkDelivery, () => {
    // Better Auth hands the link to `deliver` inside its callback; the request that asked for
    // it reads it back through `take` before it returns.
    const pending = new Map<string, string>();
    return MagicLinkDelivery.of({
      deliver: (to, url) =>
        Effect.gen(function* () {
          pending.set(to, url);
          yield* Effect.logInfo("magic link (inline)", { to, url });
        }),
      take: (to) =>
        Effect.sync(() => {
          const url = Option.fromUndefinedOr(pending.get(to));
          pending.delete(to);
          return url;
        }),
    });
  });

  static readonly layerMailed = Layer.effect(
    MagicLinkDelivery,
    Effect.gen(function* () {
      const mailer = yield* Mailer;
      return MagicLinkDelivery.of({
        deliver: (to, url) => mailer.send({ to, ...mail(url) }),
        take: () => Effect.succeedNone,
      });
    }),
  );

  /**
   * The stage's `MAGIC_LINK_DELIVERY` binding, which the stack sets, chooses the layer. It is
   * absent while the stack is planned, when nothing is delivered; a running Worker without it
   * is broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const mode = yield* Config.option(DeliveryMode);
      if (globalThis.__ALCHEMY_RUNTIME__ && Option.isNone(mode))
        return yield* Effect.die(new Error("MAGIC_LINK_DELIVERY is not bound to the Backend"));
      return Match.value(Option.getOrElse(mode, (): DeliveryMode => "mailed")).pipe(
        Match.when("inline", () => MagicLinkDelivery.layerInline),
        Match.when("mailed", () => MagicLinkDelivery.layerMailed),
        Match.exhaustive,
      );
    }),
  );
}
