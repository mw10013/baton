import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * An email address as stored and compared: trimmed, lowercased. Decode raw input with
 * {@link EmailFromInput} first.
 */
export const Email = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, { message: "Enter an email address." }),
  Schema.isMaxLength(320, { message: "Enter an email address." }),
  Schema.isLowercased(),
).pipe(Schema.brand("Email"));
export type Email = typeof Email.Type;

/**
 * Raw textbox value to {@link Email}. Trimming and lowercasing are decode steps, so the checks
 * see the normalized address.
 */
export const EmailFromInput = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim()),
  Schema.decode(SchemaTransformation.toLowerCase()),
  Schema.decodeTo(Email),
);

/** A same-origin path to land on after sign-in, such as `/admin/members`. Never `//host`. */
export const ReturnPath = Schema.String.check(Schema.isPattern(/^\/(?![/\\])\S*$/u)).pipe(
  Schema.brand("ReturnPath"),
);
export type ReturnPath = typeof ReturnPath.Type;

/** Better Auth's `user.role`: `admin` is the site's admin, never a member; anyone else is `user`. */
export const Role = Schema.Literals(["admin", "user"]);
export type Role = typeof Role.Type;

export const Me = Schema.Struct({ id: Schema.String, email: Email, role: Role });
export type Me = typeof Me.Type;

/**
 * `requestMagicLink`'s input. A method's input is declared once in the API definition and decoded
 * on both sides of the binding: the server function's validator and the Backend method read the
 * same schema, so the two cannot drift. `ShopAccessInput` follows the same rule.
 */
export const MagicLinkInput = Schema.Struct({
  email: Email,
  returnTo: Schema.optional(ReturnPath),
});
export type MagicLinkInput = typeof MagicLinkInput.Type;

/**
 * `link` is Some only under inline delivery; see `MagicLinkDelivery` in the Backend. It crosses
 * the binding encoded, as `string | null`.
 */
export const MagicLinkRequested = Schema.Struct({ link: Schema.OptionFromNullOr(Schema.String) });

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()("TooManyRequests", {}) {}

/**
 * What a server function forwards from the browser's request to the Backend; nothing else
 * crosses. Each Backend method that needs the visitor resolves the session from `cookie`
 * itself; `ip` keys the sign-in rate limit.
 */
export const RequestInfo = Schema.Struct({
  cookie: Schema.UndefinedOr(Schema.String),
  ip: Schema.UndefinedOr(Schema.String),
});
export type RequestInfo = typeof RequestInfo.Type;
