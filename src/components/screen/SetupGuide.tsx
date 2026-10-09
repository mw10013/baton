import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout";

/** A link on a {@link SetupGuideStep}: its text and where it goes. */
export interface SetupGuideLink {
  readonly label: string;
  readonly href: string;
}

/** One step of a {@link SetupGuide}. Every string is the route's; the part holds none. */
export interface SetupGuideStep {
  readonly key: string;
  readonly done: boolean;
  /** The step's state for a screen reader, beside its mark ("Done", "Not done"). */
  readonly state: string;
  /** What the step is, one line ("Create a team and add a member"). */
  readonly sentence: string;
  /** A fact under the sentence, when the step has one to say. */
  readonly body?: string;
  /** The screen where the step is done, named by its heading; a step done elsewhere has none. */
  readonly link?: SetupGuideLink;
  /** The help page that teaches the step, named by its title; it opens in a new tab. */
  readonly help: SetupGuideLink;
}

/**
 * The setup guide (the setup-guide row of the parts table on `ScreenPart` in
 * `src/lib/Screen.ts`): the home page's Getting started card, while setup
 * is undone (the rules are on `Domain.SetupFacts`). A details card whose
 * heading carries the done count on its line, then the steps in order.
 *
 * Shopify's setup-guide composition
 * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/setup-guide.md`)
 * is a checklist the merchant ticks and dismisses. Baton's steps are facts
 * Baton reads, so nothing here is a control: the mark is an `s-icon`
 * (`check-circle` done, `circle` not), not a checkbox, and there is no
 * dismiss button, since the guide goes when the facts hold. `s-icon` takes
 * no accessibility label, so the step's state sits beside it as text a
 * screen reader reads and the screen does not show.
 *
 * A done step stays where it is, marked, and loses its links, so no step
 * changes place as steps complete and a done step offers nothing to do. No
 * progress bar: the count says it in words.
 *
 * A step's two links sit on one line, wrapping, `base` apart rather than
 * the inline row's `small-300`: they are two places, and at `small-300`
 * "Teams" and the help title read as one link.
 */
export function SetupGuide({
  heading,
  count,
  steps,
}: {
  readonly heading: string;
  /** How many steps are done, as the route words it ("1 of 3 done"). */
  readonly count: string;
  readonly steps: readonly SetupGuideStep[];
}) {
  return (
    <s-section accessibilityLabel={heading}>
      <s-stack gap={BETWEEN_THINGS}>
        <s-grid
          gridTemplateColumns="1fr auto"
          gap={BETWEEN_LINES}
          alignItems="baseline"
        >
          <s-heading>{heading}</s-heading>
          <s-text color="subdued">{count}</s-text>
        </s-grid>
        <s-stack gap={BETWEEN_THINGS}>
          {steps.map((step) => (
            <s-grid
              key={step.key}
              gridTemplateColumns="auto 1fr"
              gap={BETWEEN_LINES}
            >
              <s-stack>
                <s-icon
                  type={step.done ? "check-circle" : "circle"}
                  tone={step.done ? "success" : "neutral"}
                />
                <s-text accessibilityVisibility="exclusive">
                  {step.state}
                </s-text>
              </s-stack>
              <s-stack gap={BETWEEN_LINES}>
                <s-text>{step.sentence}</s-text>
                {step.body !== undefined && (
                  <s-text color="subdued">{step.body}</s-text>
                )}
                {!step.done && (
                  <s-stack direction="inline" gap={BETWEEN_THINGS}>
                    {step.link !== undefined && (
                      <s-link href={step.link.href}>{step.link.label}</s-link>
                    )}
                    <s-link href={step.help.href} target="_blank">
                      {step.help.label}
                    </s-link>
                  </s-stack>
                )}
              </s-stack>
            </s-grid>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
