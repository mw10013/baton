import { Config, Context, Effect, Layer, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

/**
 * `code` carries Cloudflare Email Sending's string error code (e.g.
 * `E_RATE_LIMIT_EXCEEDED`, `E_RECIPIENT_SUPPRESSED`, `E_DAILY_LIMIT_EXCEEDED`):
 * the binding rejects with an `Error` whose `.code` is documented at
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export class EmailError extends Schema.TaggedError<EmailError>()("EmailError", {
  code: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Email extends Context.Service<
  Email,
  {
    readonly send: (input: {
      readonly to: string;
      readonly subject: string;
      readonly html: string;
      readonly text: string;
    }) => Effect.Effect<{ readonly messageId: string }, EmailError>;
  }
>()("Email") {
  static readonly layerNoDeps = Layer.effect(
    Email,
    Effect.gen(function* () {
      const { EMAIL: binding, ENVIRONMENT } = yield* CloudflareEnv;
      const from = yield* Config.nonEmptyString("EMAIL_FROM");
      /**
       * The plain-text body is echoed into the log annotations only when
       * `ENVIRONMENT === "local"`. Without `remote: true` on the `send_email`
       * binding no mail leaves the machine — wrangler writes the bodies to
       * `.wrangler/tmp/email/**` and prints only their paths, so a magic link
       * is otherwise unreachable from the dev terminal. The body carries
       * single-use credentials, so the gate is `ENVIRONMENT` (a
       * `wrangler.jsonc` `vars` value overridden in every deployed env block)
       * rather than `DEMO_MODE`, which a secrets file could flip on in staging
       * or production.
       */
      const send = Effect.fn("Email.send")(function* (input: {
        readonly to: string;
        readonly subject: string;
        readonly html: string;
        readonly text: string;
      }) {
        const { messageId } = yield* Effect.tryPromise({
          try: () => binding.send({ from, ...input }),
          catch: (cause) =>
            new EmailError({
              code:
                cause instanceof Error &&
                "code" in cause &&
                typeof cause.code === "string"
                  ? cause.code
                  : "E_UNKNOWN",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError(
              `Email.send: to=${input.to} code=${error.code}: ${error.message}`,
            ).pipe(Effect.annotateLogs({ to: input.to, error })),
          ),
        );
        yield* Effect.logInfo(
          `Email.send: to=${input.to} status=sent messageId=${messageId}`,
        ).pipe(
          Effect.annotateLogs({
            to: input.to,
            subject: input.subject,
            messageId,
            ...(ENVIRONMENT === "local" ? { text: input.text } : {}),
          }),
        );
        return { messageId };
      });
      return Email.of({ send });
    }),
  );
}
