import { type ComponentRef, useLayoutEffect, useRef, useState } from "react";
import { Lines } from "./Lines.tsx";

/**
 * A block reason on its home: free text as `Prose` prints it, cut to three lines, with a Show more / Show
 * less toggle only when the cut hides something. A block reason may run to
 * `BLOCK_REASON_MAX_LENGTH` characters, and at full length the banner holding it is taller than
 * the rest of the card; typical reasons fit in one or two lines and never see the toggle.
 *
 * Whether the cut hides anything depends on the width, so it is measured, not guessed from the
 * character count: a count threshold either clamps a reason that fits (a Show more that reveals
 * nothing) or leaves one uncut that does not. `s-paragraph`'s `lineClamp` clamps an element
 * inside its open shadow root, rendered synchronously on connect, and that element's
 * `scrollHeight` exceeding its `clientHeight` is the overflow. If the element is not there
 * (Polaris changed its markup) the text renders in full rather than clipped with no way to expand
 * it.
 *
 * The caller keys it on the text, so a new reason starts collapsed and is measured afresh: a text
 * that goes from three lines to four keeps the same clamped height, and no resize would fire to
 * say it now overflows.
 *
 * | part      | job                                                      | component                       | fixes                                                                                                 | used on                          | never                 |
 * | --------- | -------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------- |
 * | free text | a block reason, a note, task instructions, an order note | `Clamp`, `Prose`, `ClampedProse` | on a list: two lines; on its home: `Prose`, a block reason `ClampedProse`; in a cutting control: never | index, details, homepage, editor | collapsed line breaks |
 */
export function ClampedProse({ children }: { readonly children: string }) {
  const ref = useRef<ComponentRef<"s-paragraph">>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState<"unknown" | "none" | "clipped" | "unmeasurable">(
    "unknown",
  );
  useLayoutEffect(() => {
    const inner = ref.current?.shadowRoot?.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (inner instanceof HTMLElement && !expanded)
        setOverflow(inner.scrollHeight > inner.clientHeight + 1 ? "clipped" : "none");
    });
    if (inner instanceof HTMLElement) observer.observe(inner);
    else setOverflow("unmeasurable");
    return () => {
      observer.disconnect();
    };
  }, [expanded]);
  const clamp = !expanded && overflow !== "unmeasurable";
  return (
    <Lines>
      <div className="prose">
        <s-paragraph ref={ref} lineClamp={clamp ? 3 : undefined}>
          {children}
        </s-paragraph>
      </div>
      {/* A link, not a tertiary button: the button's inline padding sets it off from the text's
          left edge, where a link lines up. */}
      {(expanded || overflow === "clipped") && (
        <s-text>
          <s-link
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {expanded ? "Show less" : "Show more"}
          </s-link>
        </s-text>
      )}
    </Lines>
  );
}
