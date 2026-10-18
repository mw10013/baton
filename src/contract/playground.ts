import * as Schema from "effect/Schema";

/**
 * The text Shout accepts: trimmed, 1 to 80 characters. A payload field's checks run on the
 * client, which constructs the payload with the schema, and on the server, so a value of this
 * type has already passed them. Decode raw input with {@link ShoutTextFromInput} first.
 */
export const ShoutText = Schema.Trimmed.check(
  Schema.isBetweenLength(1, 80, { message: "Enter 1 to 80 characters." }),
).pipe(Schema.brand("ShoutText"));
export type ShoutText = typeof ShoutText.Type;

/**
 * Raw textbox value to {@link ShoutText}. Trim is a decode step, so the length check sees the
 * trimmed text.
 */
export const ShoutTextFromInput = Schema.Trim.pipe(Schema.decodeTo(ShoutText));

/**
 * A method's input, declared once here and decoded on both sides of the binding: the server
 * function's validator and the Backend method read the same schema, so the two cannot drift.
 * `MagicLinkInput` and `ShopAccessInput` follow the same rule.
 */
export const ShoutInput = Schema.Struct({ input: ShoutText });
export type ShoutInput = typeof ShoutInput.Type;

export const Hello = Schema.Struct({ message: Schema.String, servedAt: Schema.String });
export const Shouted = Schema.Struct({ input: ShoutText, output: Schema.String });
