/**
 * Formats Standard Schema field issues for Shopify UI error props.
 * TanStack Form's inferred meta error type includes undefined entries even when Effect emits required messages.
 * Dedupes by message because paths are not rendered here.
 */
export const fieldError = (
  errors: readonly ({ readonly message: string } | undefined)[],
) =>
  [
    ...new Map(
      errors.filter((error) => !!error).map((error) => [error.message, error]),
    ).values(),
  ]
    .map((error) => error.message)
    .join(", ");

const issueMessage = (issue: unknown): string | undefined => {
  if (!issue || typeof issue !== "object" || !("message" in issue))
    return undefined;
  const { message } = issue;
  if (typeof message === "string") return message;
  return undefined;
};

/**
 * Formats mutation failures for merchant-visible UI. TanStack Start standard-schema
 * input validation throws JSON-stringified issue arrays; those are parsed, message
 * fields are deduped, and all other error shapes keep their original message.
 */
export const mutationErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : undefined;
  if (!message) return fallback;
  try {
    const issues = JSON.parse(message) as unknown;
    if (!Array.isArray(issues)) return message;
    const messages = issues
      .map(issueMessage)
      .filter(
        (issueMessage): issueMessage is string =>
          typeof issueMessage === "string" && issueMessage.length > 0,
      );
    if (messages.length === 0) return message;
    return [...new Set(messages)].join(", ");
  } catch {
    return message;
  }
};
