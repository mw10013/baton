import * as React from "react";

import { Clamp } from "@/components/screen/Clamp";
import { Lines } from "@/components/screen/Lines";
import { textLimitError, textLimitProps } from "@/components/screen/TextLimit";
import * as Domain from "@/lib/Domain";
import * as PolarisModal from "@/lib/polarisModal";

/**
 * One text field in an `s-modal`, the shape both run texts share: the draft
 * opens holding what is there now (one field, last write wins, so seeing what
 * you are about to replace is the only warning there is), the cursor lands at
 * the end so appending is the easy path, and a draft that differs from the
 * saved text marks the modal dirty so a stray backdrop click does not lose it.
 *
 * The draft is `null` until the field takes input and is reset on the way out
 * (`onAfterHide`), not on the way in: `show` can fire after the field has
 * already taken input, and a reset there wipes what was typed. `afterhide`
 * fires once the exit animation ends, which can be after the same modal has
 * been shown again and typed into (Save, then Edit straight away), so the
 * reset is skipped when a `show` has started since the `hide`; otherwise it
 * wiped the new draft, the field fell back to the saved text, and Save
 * stayed disabled as not dirty. `close` resets on its own because it is the
 * one exit that knows the draft is finished with.
 */
function TextModal({
  id,
  heading,
  subject,
  label,
  labelHidden,
  saved,
  maxLength,
  pending,
  submitLabel,
  critical,
  allowUnchanged,
  onSubmit,
}: {
  readonly id: string;
  readonly heading: string;
  /** The body's first line: the thing the heading's verb acts on, clamped ({@link Clamp}). */
  readonly subject?: string;
  readonly label: string;
  /** Hide the label visually when the heading already says it; screen readers still get it. */
  readonly labelHidden?: boolean;
  readonly saved: string;
  readonly maxLength: number;
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly critical?: boolean;
  /** Block submits with no change: an empty reason is a valid block. */
  readonly allowUnchanged?: boolean;
  /** Resolves `null` when the write landed and the modal closes, or the message to show under the field. */
  readonly onSubmit: (text: string) => Promise<string | null>;
}) {
  const field = React.useRef<HTMLElementTagNameMap["s-text-area"]>(null);
  /** True from `show` to `hide`; a late `afterhide` must not reset a reopened modal. */
  const showing = React.useRef(false);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  PolarisModal.useModalBackdropDismissGuard(id);
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  React.useEffect(() => {
    PolarisModal.setModalDirty(id, dirty);
  }, [id, dirty]);
  const close = () => {
    PolarisModal.setModalDirty(id, false);
    setDraft(null);
    setError(null);
    PolarisModal.hideModal(id);
  };
  return (
    <s-modal
      id={id}
      heading={heading}
      onShow={() => {
        showing.current = true;
      }}
      onHide={() => {
        showing.current = false;
      }}
      onAfterShow={() => {
        // Polaris focuses the first control but leaves the caret at the
        // start; the native textarea is inside the element's shadow root.
        const textarea =
          field.current?.shadowRoot?.querySelector("textarea") ?? null;
        textarea?.focus();
        textarea?.setSelectionRange(
          textarea.value.length,
          textarea.value.length,
        );
      }}
      onAfterHide={() => {
        if (showing.current) return;
        setDraft(null);
        setError(null);
      }}
    >
      <Lines>
        {subject !== undefined && <Clamp>{subject}</Clamp>}
        <s-text-area
          ref={field}
          label={label}
          {...(labelHidden === true
            ? { labelAccessibilityVisibility: "exclusive" as const }
            : {})}
          rows={6}
          value={value}
          disabled={pending}
          {...textLimitProps(value, maxLength)}
          {...(error === null ? {} : { error })}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
        />
      </Lines>
      <s-button slot="secondary-actions" onClick={close}>
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        {...(critical === true ? { tone: "critical" as const } : {})}
        loading={pending}
        disabled={pending || (!dirty && allowUnchanged !== true)}
        onClick={() => {
          const limit = textLimitError(value, maxLength);
          if (limit !== null) {
            setError(limit);
            return;
          }
          void onSubmit(value).then((message) => {
            setError(message);
            if (message === null) close();
          });
        }}
      >
        {submitLabel}
      </s-button>
    </s-modal>
  );
}

/**
 * The run note's editor. One per page: a page with several runs points it at
 * one by passing that run's `note` before opening it.
 */
export function RunNoteModal({
  id,
  note,
  pending,
  onSave,
}: {
  readonly id: string;
  readonly note: string | null;
  readonly pending: boolean;
  readonly onSave: (note: string) => Promise<string | null>;
}) {
  return (
    <TextModal
      id={id}
      heading="Note"
      label="Note"
      labelHidden
      saved={note ?? ""}
      maxLength={Domain.RUN_NOTE_MAX_LENGTH}
      pending={pending}
      submitLabel="Save"
      onSubmit={onSave}
    />
  );
}

/**
 * Block: the heading asks the question and names the order ("Block
 * #1008?"), and the body's first line names the item, clamped to two lines
 * (the copy table's heading row on `CopySlot`): an item title is Shopify
 * text of up to 255 characters, and in the heading it made a seven-line
 * question. The primary is a critical Block.
 * A standing block's reason is not edited: Unblock, then Block with the new
 * reason ({@link Domain.runActions}). The field has no placeholder: it is free text and the label
 * says what goes in, so a placeholder could only ask a question or give an
 * instruction, and both are filler (`scripts/lib/rules-lint.ts` refuses a
 * placeholder on any `s-text-area`).
 */
export function BlockModal({
  id,
  run,
  pending,
  onBlock,
}: {
  readonly id: string;
  readonly run: Pick<
    Domain.Run,
    "lineItemTitle" | "variantTitle" | "quantity" | "orderName"
  >;
  readonly pending: boolean;
  readonly onBlock: (reason: string) => Promise<string | null>;
}) {
  return (
    <TextModal
      id={id}
      heading={`Block ${run.orderName}?`}
      subject={Domain.itemTitle(run)}
      label="Reason"
      saved=""
      maxLength={Domain.BLOCK_REASON_MAX_LENGTH}
      pending={pending}
      submitLabel={Domain.VERB_LABEL.block.member}
      critical
      allowUnchanged
      onSubmit={onBlock}
    />
  );
}
