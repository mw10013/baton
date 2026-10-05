import * as React from "react";

import { Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";

/**
 * Raw field text to the branded search, or `None` for anything the schema
 * refuses: empty, blank, or past its 64 characters. `None` is "no search",
 * which is what an emptied field means, so the caller needs no second test.
 * The field sets no `maxLength`: Polaris would draw a character counter, and
 * no order number or item word comes near the limit.
 */
const decodeListSearch = Schema.decodeUnknownOption(Domain.ListSearch);

/**
 * The search field of every list: the orders index and the member's
 * workflows list, whose placeholder is the default "Search by order number
 * or item", and the workflows index, which searches by name. Label "Search"
 * (hidden, the placeholder says it), the placeholder the `placeholder`
 * slot's "Search by <field>" (`CopySlot`), and what it finds is
 * {@link Domain.searchTerm}'s.
 *
 * `value` is the search in the URL; the field's text is the draft on the way
 * to it, so a keystroke is not a navigation and not a read. The draft
 * re-seeds whenever `value` changes from outside the field (Clear search, a
 * back button), the same seeded-state shape the workflow pages use for a
 * loaded name.
 *
 * Enter and blur submit, not a debounce: every other control beside it
 * navigates on the person's own action, and a timer that navigated mid-word
 * would page the list under the typing. A no-op submit is dropped so
 * re-blurring an unchanged field costs nothing. An emptied field submits at
 * once: no half-typed word is in it, and the field's own clear control
 * leaves focus where it was.
 */
export function ListSearchField({
  value,
  placeholder = "Search by order number or item",
  onSubmit,
}: {
  readonly value: Domain.ListSearch | null;
  /** The `placeholder` slot, "Search by <field>": the field the list's search reads. */
  readonly placeholder?: string;
  readonly onSubmit: (next: Domain.ListSearch | null) => void;
}) {
  const [draft, setDraft] = React.useState<string>(value ?? "");
  const [seeded, setSeeded] = React.useState<string | null>(value);
  if (value !== seeded) {
    setSeeded(value);
    setDraft(value ?? "");
  }
  const submit = (text: string = draft) => {
    const next = Option.getOrNull(decodeListSearch(text));
    if (next === value) return;
    onSubmit(next);
  };
  /**
   * The latest submit, held in a ref so the keydown listener below is attached
   * once per element rather than on every keystroke: `submit` closes over the
   * draft, so it is a new function each render.
   */
  const submitRef = React.useRef(submit);
  React.useEffect(() => {
    submitRef.current = submit;
  });
  /**
   * The field's shadow input does not submit a surrounding form, so Enter is
   * listened for on the custom element (as `WorkflowTag` does). Held in state,
   * not a ref, so a remounted element gets the listener too.
   */
  const [element, setElement] = React.useState<
    HTMLElementTagNameMap["s-search-field"] | null
  >(null);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        submitRef.current();
      }
    };
    element?.addEventListener("keydown", onKeyDown);
    return () => element?.removeEventListener("keydown", onKeyDown);
  }, [element]);
  return (
    <s-search-field
      ref={setElement}
      label="Search"
      labelAccessibilityVisibility="exclusive"
      placeholder={placeholder}
      value={draft}
      onInput={(event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        if (text === "") submit(text);
      }}
      onBlur={() => {
        submit();
      }}
    />
  );
}
