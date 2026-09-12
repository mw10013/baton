import * as React from "react";

import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import * as PolarisModal from "@/lib/polarisModal";

const MODAL = "workflow-tag";

/**
 * The editor's tag dialog, designed for one tag with the array as an escape
 * hatch. A workflow's tag is its own name in a form a product can carry, so
 * the primary state is a single field whose value *is* the tag; "Add another
 * tag" expands into the add-field-plus-chips list for the transitional cases
 * (renaming a tag across the catalogue, merging two product families). Once
 * expanded it stays expanded until the dialog closes, so removing down to one
 * tag does not collapse the UI under the merchant.
 *
 * Saves land on the draft, never the workflow: `tags` change only through
 * Apply so an order arriving mid-edit never sees a half definition.
 */
export function WorkflowTag({
  tags,
  disabled,
  defaultOpen = false,
  onClose,
  onSave,
}: {
  readonly tags: readonly string[];
  readonly disabled: boolean;
  /** Open the dialog once on mount — the detail page's Edit tag deep link. */
  readonly defaultOpen?: boolean;
  readonly onClose?: () => void;
  readonly onSave: (tags: readonly string[]) => Promise<void>;
}) {
  const modal = React.useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const field = React.useRef<HTMLElementTagNameMap["s-text-field"]>(null);
  const [selection, setSelection] = React.useState<readonly string[] | null>(
    null,
  );
  /** Primary state: the single field's text, the tag itself, edited in place. */
  const [single, setSingle] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  PolarisModal.useModalBackdropDismissGuard(MODAL);

  /** Keep the working selection when the admin host dismisses the overlay unexpectedly. Only Cancel or a successful save discards it. */
  const selected = selection ?? tags;
  const showList = expanded || selected.length > 1;
  const singleValue = single ?? tags[0] ?? "";
  const singleNormalized = singleValue.trim().toLowerCase();
  /** What Save writes: the list when expanded, else the one field folded to `[value]` or `[]`. */
  const singleAsList = singleNormalized === "" ? [] : [singleNormalized];
  const next: readonly string[] = showList ? selected : singleAsList;
  const normalizedInput = input.trim().toLowerCase();
  const duplicate = selected.includes(normalizedInput);
  const changed =
    next.length !== tags.length || next.some((tag) => !tags.includes(tag));
  const busy = disabled || saving;

  const open = React.useCallback(() => {
    setSelection((current) => current ?? tags);
    setSingle((current) => current ?? tags[0] ?? "");
    modal.current?.showOverlay();
  }, [tags]);

  const reset = () => {
    setSelection(null);
    setSingle(null);
    setExpanded(false);
    setInput("");
    setError(null);
  };

  React.useEffect(() => {
    if (defaultOpen) open();
    // Once on mount only: the deep link opens the dialog, later prop changes do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = React.useCallback(() => {
    if (busy || normalizedInput.length === 0 || duplicate) return;
    if (normalizedInput.length > 255) {
      setError("Use 255 characters or fewer for each tag.");
      return;
    }
    if (selected.length >= Domain.WorkflowLimits.maxTags) {
      setError(`Choose at most ${String(Domain.WorkflowLimits.maxTags)} tags.`);
      return;
    }
    setSelection([...selected, normalizedInput]);
    setInput("");
    setError(null);
  }, [busy, normalizedInput, duplicate, selected]);

  /** The field's shadow input does not implicitly submit the surrounding form on Enter, so listen on the custom element for the composed keyboard event. */
  React.useEffect(() => {
    const element = field.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        add();
      }
    };
    element?.addEventListener("keydown", onKeyDown);
    return () => element?.removeEventListener("keydown", onKeyDown);
  }, [add, showList]);

  /** Expanding carries the single field's current text into the list, so nothing typed is lost. */
  const expand = () => {
    setSelection(singleAsList);
    setExpanded(true);
    setError(null);
  };

  const save = async () => {
    if (busy || !changed || input.trim().length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const normalized = Schema.decodeUnknownSync(Domain.WorkflowTags)(next);
      await onSave(normalized);
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
      <s-stack direction="inline" gap="small-300">
        {tags.map((tag) => (
          <s-chip key={tag}>{tag}</s-chip>
        ))}
      </s-stack>
      <s-button disabled={busy} onClick={open}>
        Edit tag
      </s-button>
      <s-modal id={MODAL} ref={modal} heading="Edit tag" onHide={onClose}>
        <s-stack gap="base">
          <s-paragraph>
            This workflow's tag. Add it to your products in Shopify — items on
            those products follow this workflow. Editing it here does not change
            any product.
          </s-paragraph>
          {error !== null && <s-banner tone="critical">{error}</s-banner>}
          {showList ? (
            <>
              <form
                aria-label="Add a tag"
                onSubmit={(event) => {
                  event.preventDefault();
                  add();
                }}
              >
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="small-300"
                  alignItems="end"
                >
                  <s-text-field
                    ref={field}
                    label="Add a tag"
                    placeholder="e.g. engraved"
                    value={input}
                    disabled={busy}
                    onInput={(event) => {
                      setInput(event.currentTarget.value);
                      setError(null);
                    }}
                  />
                  <s-button
                    type="submit"
                    disabled={busy || normalizedInput.length === 0 || duplicate}
                  >
                    Add
                  </s-button>
                </s-grid>
                {/* Outside the grid: `details` inside the field would sit under it and push the field above the button's baseline. */}
                <s-paragraph color="subdued">
                  {duplicate
                    ? "This tag is already selected."
                    : "Add one tag at a time."}
                </s-paragraph>
              </form>
              <s-heading>Tags</s-heading>
              {selected.length === 0 ? (
                <s-paragraph>
                  No tag yet. Nothing reaches this workflow.
                </s-paragraph>
              ) : (
                <s-stack direction="inline" gap="small-300">
                  {selected.map((tag) => (
                    <s-clickable-chip
                      key={tag}
                      removable
                      disabled={busy}
                      accessibilityLabel={`Remove ${tag}`}
                      onRemove={() => {
                        setSelection(selected.filter((other) => other !== tag));
                        setError(null);
                      }}
                    >
                      {tag}
                    </s-clickable-chip>
                  ))}
                </s-stack>
              )}
            </>
          ) : (
            <s-stack gap="small-300" alignItems="start">
              <s-box inlineSize="100%">
                <s-text-field
                  label="Tag"
                  placeholder="e.g. engraved"
                  value={singleValue}
                  maxLength={255}
                  disabled={busy}
                  details={
                    singleNormalized === ""
                      ? "No tag yet. Nothing reaches this workflow."
                      : undefined
                  }
                  onInput={(event) => {
                    setSingle(event.currentTarget.value);
                    setError(null);
                  }}
                />
              </s-box>
              <s-button variant="tertiary" disabled={busy} onClick={expand}>
                + Add another tag
              </s-button>
            </s-stack>
          )}
          <s-paragraph color="subdued">
            Save to your draft, then apply changes when you're ready.
          </s-paragraph>
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
          disabled={busy || !changed || input.trim().length > 0}
          onClick={() => {
            void save();
          }}
        >
          Save to draft
        </s-button>
      </s-modal>
    </>
  );
}
