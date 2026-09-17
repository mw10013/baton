import * as React from "react";

import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import * as PolarisModal from "@/lib/polarisModal";
import { workflowResultMessage } from "@/lib/workflowShared";

const MODAL = "workflow-tag";

/**
 * The link under a tag field that has just been refused. `tagTakenMessage`
 * names the holder, but a name no longer identifies a workflow — two may share
 * one — so the merchant needs a way to reach the row the refusal meant. A
 * Polaris text field takes its `error` as a string, so the link cannot live
 * inside the field error and sits under it instead.
 */
export function TagTakenLink({
  holder,
}: {
  readonly holder: {
    readonly workflowId: string;
    readonly workflowName: string;
  } | null;
}) {
  if (holder === null) return null;
  return (
    <s-link href={`/app/workflows/${holder.workflowId}`}>
      {`Open ${holder.workflowName}`}
    </s-link>
  );
}

/**
 * Edit tag: one field, because a workflow has exactly one tag. The write is
 * immediate and lands on the workflow row, not the draft — the tag is the
 * workflow's identity, the sibling of its name, and runs snapshot it at start
 * so nothing in flight moves.
 *
 * The result comes back rather than a throw so `TagTaken` can be rendered
 * under the field: the workflow has two unique keys and the merchant has to be
 * told which of them to change.
 */
export function WorkflowTag({
  tag,
  disabled,
  onSave,
}: {
  readonly tag: string;
  readonly disabled: boolean;
  /** Resolves with the result; `TagTaken` and its siblings render under the field. */
  readonly onSave: (tag: Domain.WorkflowTag) => Promise<Domain.WorkflowResult>;
}) {
  const modal = React.useRef<HTMLElementTagNameMap["s-modal"]>(null);
  /** Null until the dialog is opened; the working text survives an unexpected dismissal, and only Cancel or a successful save discards it. */
  const [working, setWorking] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [taken, setTaken] = React.useState<{
    readonly workflowId: string;
    readonly workflowName: string;
  } | null>(null);
  const [saving, setSaving] = React.useState(false);
  PolarisModal.useModalBackdropDismissGuard(MODAL);

  const value = working ?? tag;
  const folded = value.trim().toLowerCase();
  const busy = disabled || saving;
  const changed = folded !== tag;

  const reset = () => {
    setWorking(null);
    setError(null);
    setTaken(null);
  };

  const save = async () => {
    if (busy || folded === "" || !changed) return;
    setSaving(true);
    setError(null);
    setTaken(null);
    try {
      const result = await onSave(
        Schema.decodeUnknownSync(Domain.WorkflowTag)(folded),
      );
      const message = workflowResultMessage(result);
      if (message !== null) {
        setError(message);
        if (result._tag === "TagTaken")
          setTaken({
            workflowId: result.workflowId,
            workflowName: result.workflowName,
          });
        return;
      }
      reset();
      modal.current?.hideOverlay();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Couldn't save the tag. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-chip>{tag}</s-chip>
        <s-button
          disabled={busy}
          onClick={() => {
            setWorking((current) => current ?? tag);
            modal.current?.showOverlay();
          }}
        >
          Edit tag
        </s-button>
      </s-stack>
      <s-modal id={MODAL} ref={modal} heading="Edit tag">
        <s-stack gap="base">
          <s-paragraph>
            Put this tag on the products this workflow should build, in Shopify.
            Changing it here changes nothing on your products.
          </s-paragraph>
          <s-text-field
            label="Tag"
            placeholder="e.g. engraved"
            value={value}
            maxLength={255}
            disabled={busy}
            {...(error === null ? {} : { error })}
            onInput={(event) => {
              setWorking(event.currentTarget.value);
              setError(null);
              setTaken(null);
            }}
          />
          <TagTakenLink holder={taken} />
        </s-stack>
        <s-button
          slot="secondary-actions"
          disabled={saving}
          onClick={() => {
            reset();
            modal.current?.hideOverlay();
          }}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={saving}
          disabled={busy || folded === "" || !changed}
          onClick={() => {
            void save();
          }}
        >
          Save
        </s-button>
      </s-modal>
    </>
  );
}
