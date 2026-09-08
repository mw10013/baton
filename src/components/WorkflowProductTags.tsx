import * as React from "react";

import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import * as PolarisModal from "@/lib/polarisModal";

const MODAL = "workflow-product-tags";

export function WorkflowProductTags({
  tags,
  disabled,
  onSave,
}: {
  readonly tags: readonly string[];
  readonly disabled: boolean;
  readonly onSave: (tags: readonly string[]) => Promise<void>;
}) {
  const modal = React.useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const field = React.useRef<HTMLElementTagNameMap["s-text-field"]>(null);
  const [selection, setSelection] = React.useState<readonly string[] | null>(
    null,
  );
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  PolarisModal.useModalBackdropDismissGuard(MODAL);

  /** Keep the working selection when the admin host dismisses the overlay unexpectedly. Only Cancel or a successful save discards it. */
  const selected = selection ?? tags;
  const normalizedInput = input.trim().toLowerCase();
  const duplicate = selected.includes(normalizedInput);
  const changed =
    selected.length !== tags.length ||
    selected.some((tag) => !tags.includes(tag));
  const busy = disabled || saving;

  const add = React.useCallback(() => {
    if (busy || normalizedInput.length === 0 || duplicate) return;
    if (normalizedInput.length > 255) {
      setError("Use 255 characters or fewer for each tag.");
      return;
    }
    if (selected.length >= Domain.WorkflowLimits.maxTags) {
      setError(
        `Choose at most ${String(Domain.WorkflowLimits.maxTags)} product tags.`,
      );
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
  }, [add]);

  const save = async () => {
    if (busy || !changed || input.trim().length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const normalized = Schema.decodeUnknownSync(Domain.ProductTags)(selected);
      await onSave(normalized);
      setSelection(null);
      setInput("");
      modal.current?.hideOverlay();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Couldn't save product tags. Try again.",
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
      <s-button
        disabled={busy}
        onClick={() => {
          setSelection((current) => current ?? tags);
          modal.current?.showOverlay();
        }}
      >
        Manage tags
      </s-button>
      <s-modal id={MODAL} ref={modal} heading="Manage product tags">
        <s-stack gap="base">
          <s-paragraph>
            Choose which product tags match this workflow. This does not change
            tags on your Shopify products.
          </s-paragraph>
          {error !== null && <s-banner tone="critical">{error}</s-banner>}
          <form
            aria-label="Add a product tag"
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
                label="Add a product tag"
                placeholder="e.g. engraved"
                value={input}
                disabled={busy}
                details={
                  duplicate
                    ? "This tag is already selected."
                    : "Add one tag at a time."
                }
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
          </form>
          <s-heading>Selected product tags</s-heading>
          {selected.length === 0 ? (
            <s-paragraph>
              No product tags selected. This workflow won't start.
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
          <s-paragraph color="subdued">
            Save these tags to your draft, then apply changes when you're ready.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="secondary-actions"
          disabled={saving}
          onClick={() => {
            setSelection(null);
            setInput("");
            setError(null);
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
