import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { ListSearch } from "../../../domain/shop-work.ts";

/**
 * Raw field text to the branded search, or `None` for anything the schema refuses: empty,
 * blank, or past its 64 characters. `None` is "no search", which is what an emptied field means,
 * so the caller needs no second test. The field sets no `maxLength` (the text-limit rule on
 * `TextLimit`): Polaris would draw a character counter, and no search comes near the limit, so
 * the field neither counts down nor errs.
 */
const decodeListSearch = Schema.decodeUnknownOption(ListSearch);

/**
 * The search field of every list. Label "Search" (hidden, the placeholder says it), the
 * placeholder "Search by <field>".
 *
 * `value` is the search in the URL; the field's text is the draft on the way to it, so a
 * keystroke is not a navigation and not a read. The draft re-seeds whenever `value` changes from
 * outside the field (Clear search, a back button).
 *
 * Enter and blur submit, not a debounce: every other control beside it navigates on the
 * person's own action, and a timer that navigated mid-word would page the list under the typing.
 * A no-op submit is dropped so re-blurring an unchanged field costs nothing. An emptied field
 * submits at once: no half-typed word is in it, and the field's own clear control leaves focus
 * where it was.
 *
 * | part         | job               | component         | fixes                     | used on | never                           |
 * | ------------ | ----------------- | ----------------- | ------------------------- | ------- | ------------------------------- |
 * | search field | the list's search | `ListSearchField` | submits on Enter and blur | index   | a debounce; a character counter |
 */
export function ListSearchField({
  value,
  placeholder,
  onSubmit,
  slot,
}: {
  readonly value: ListSearch | null;
  /** "Search by <field>": the field the list's search reads. */
  readonly placeholder: string;
  readonly onSubmit: (next: ListSearch | null) => void;
  /** `filters` puts the field in its `s-table`'s filters slot, as the admin console's Shops list does. */
  readonly slot?: "filters";
}) {
  const [draft, setDraft] = useState<string>(value ?? "");
  const [seeded, setSeeded] = useState<string | null>(value);
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
   * The latest submit, held in a ref so the keydown listener below is attached once per element
   * rather than on every keystroke: `submit` closes over the draft, so it is a new function each
   * render.
   */
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  /**
   * The field's shadow input does not submit a surrounding form, so Enter is listened for on the
   * custom element. Held in state, not a ref, so a remounted element gets the listener too.
   */
  const [element, setElement] = useState<HTMLElementTagNameMap["s-search-field"] | null>(null);
  useEffect(() => {
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
      {...(slot === undefined ? {} : { slot })}
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
