import * as React from "react";

import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import * as PolarisModal from "@/lib/polarisModal";

/**
 * How much room is left, shown only from {@link Domain.noteCountFrom}. Without
 * it the cap is invisible until the write refuses a paragraph that is already
 * typed, and the refusal the writer would read is the schema's own words.
 */
const countdown = (draft: string, maxLength: number) =>
  draft.length < Domain.noteCountFrom(maxLength)
    ? {}
    : { details: `${formatNumber(maxLength - draft.length)} characters left` };

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
  label,
  labelHidden,
  placeholder,
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
  readonly label: string;
  /** Hide the label visually when the heading already says it; screen readers still get it. */
  readonly labelHidden?: boolean;
  readonly placeholder?: string;
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
      <s-text-area
        ref={field}
        label={label}
        {...(labelHidden === true
          ? { labelAccessibilityVisibility: "exclusive" as const }
          : {})}
        {...(placeholder === undefined ? {} : { placeholder })}
        rows={6}
        value={value}
        disabled={pending}
        {...countdown(value, maxLength)}
        {...(error === null ? {} : { error })}
        onInput={(event) => {
          setDraft(event.currentTarget.value);
          setError(null);
        }}
      />
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
 * Block, and the edit of a standing block's reason, in one modal driven by
 * {@link Domain.runIsBlocked}. Not blocked, it sets the hold: the heading
 * asks the question and the primary is a critical Block. Blocked, it rewrites
 * the reason and nothing else: there is no Block to press on a run that is
 * already held.
 */
export function BlockModal({
  id,
  run,
  pending,
  onBlock,
  onSaveReason,
}: {
  readonly id: string;
  readonly run: Pick<Domain.Run, "orderName" | "blockedAt" | "blockReason">;
  readonly pending: boolean;
  readonly onBlock: (reason: string) => Promise<string | null>;
  readonly onSaveReason: (reason: string) => Promise<string | null>;
}) {
  const blocked = Domain.runIsBlocked(run);
  return (
    <TextModal
      id={id}
      heading={blocked ? "Block reason" : `Block ${run.orderName}?`}
      label="Reason"
      placeholder="What is stopping this? Who needs to know?"
      saved={blocked ? (run.blockReason ?? "") : ""}
      maxLength={Domain.BLOCK_REASON_MAX_LENGTH}
      pending={pending}
      submitLabel={blocked ? "Save" : "Block"}
      critical={!blocked}
      allowUnchanged={!blocked}
      onSubmit={blocked ? onSaveReason : onBlock}
    />
  );
}
