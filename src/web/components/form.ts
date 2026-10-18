import { revalidateLogic } from "@tanstack/react-form";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * TanStack Form validation from the shared codec: `schema` decides what each field accepts,
 * and its issue messages become the field's error ({@link fieldError}). A field validates on
 * submit, then on every change until it is fixed.
 *
 * Validation passes only values that decode, and the form keeps the raw text, so `onSubmit`
 * decodes again with `decode`.
 *
 * @example
 * const SignInForm = schemaForm(Schema.Struct({ email: EmailFromInput }));
 * const form = useForm({
 *   defaultValues: { email: "" },
 *   ...SignInForm.options,
 *   onSubmit: ({ value }) => requestMagicLink(SignInForm.decode(value).email),
 * });
 */
export const schemaForm = <S extends Schema.Codec<any, any>>(schema: S) => ({
  options: {
    validationLogic: revalidateLogic(),
    validators: { onDynamic: Schema.toStandardSchemaV1(schema) },
  },
  decode: Schema.decodeSync(schema),
});

/** A Polaris field's `error` prop: its first issue's message, or none while it is valid. */
export const fieldError = (errors: ReadonlyArray<{ readonly message: string } | undefined>) =>
  Option.getOrUndefined(Option.map(Option.fromNullishOr(errors[0]), (issue) => issue.message));

/**
 * A press that failed with no typed answer (a lost socket, a defect): its message, as legacy
 * shows it, or `fallback`.
 */
export const thrownCopy = (error: unknown, fallback: string) =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

/**
 * The value of a filter select's "Any <noun>" option, the one that turns the filter off. Not
 * `""`: an `s-option` with an empty value reports its label as its value, as a native option does,
 * so a select whose `value` is `""` matches no option and shows the first one only by the
 * browser's fallback. With a value every option can be matched, the chosen option is the select's
 * answer rather than the browser's, and a test reads the value instead of the checked option's
 * text. The screen maps it to `null` on change and back on render; it never reaches a URL or a
 * read.
 */
export const ANY_OPTION_VALUE = "any";
