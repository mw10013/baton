/**
 * Preformatted text in a subdued box (the code-block row of the parts table
 * on `ScreenPart` in `src/lib/Screen.ts`): a stack trace on the error page.
 * `.code-block` in `styles.css` keeps the line breaks, drops the browser's
 * margin on `pre`, and lets a long line scroll inside the box rather than
 * widen the page.
 */
export function CodeBlock({ children }: { readonly children: string }) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <pre className="code-block">
        <code>{children}</code>
      </pre>
    </s-box>
  );
}
