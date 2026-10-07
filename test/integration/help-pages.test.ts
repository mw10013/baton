import { describe, expect, it } from "vitest";

import { HELP_BODIES } from "@/components/help/bodies";
import { findHelpPage, findHelpSection, HELP_SECTIONS } from "@/lib/helpPages";

import { RETIRED } from "../../scripts/lib/rules-lint.ts";

/**
 * The help tree (`HELP_SECTIONS` in `src/lib/helpPages.ts`) and the bodies
 * registered against it. The tree lives under `src/lib/`, which the
 * retired-word lint does not read, so its copy is pinned here.
 */

const SLUG = /^[a-z0-9-]+$/u;

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

describe("help pages", () => {
  it("every help page has a unique route and a title that is its heading", () => {
    expect(unique(HELP_SECTIONS.map((section) => section.slug))).toBe(true);
    for (const section of HELP_SECTIONS) {
      expect(unique(section.pages.map((page) => page.slug))).toBe(true);
      for (const entry of [section, ...section.pages]) {
        expect(entry.slug).toMatch(SLUG);
        expect(entry.title.trim()).not.toBe("");
        expect(entry.description.trim()).not.toBe("");
        expect(entry.title.endsWith(".")).toBe(false);
        expect(entry.title.endsWith("?")).toBe(false);
      }
    }
  });

  /**
   * A title is held to the patterns that match anywhere in the copy, not to
   * the ones anchored at its start: those refuse a status sentence ("Saving
   * …", "Syncing …", "Remove …?"), and a task page's title is a gerund by
   * rule ("Syncing from Shopify"), a heading rather than a write in flight.
   * The question form ("Remove …?") cannot reach a title either: the first
   * test refuses a title that ends in "?". A description is held to every
   * pattern.
   */
  it("help copy is free of the retired words", () => {
    const anywhere = RETIRED.filter(
      (pattern) => !pattern.source.startsWith("^"),
    );
    const entries = HELP_SECTIONS.flatMap((section) => [
      section,
      ...section.pages,
    ]);
    const hits = [
      ...entries
        .map((entry) => entry.title)
        .filter((title) => anywhere.some((pattern) => pattern.test(title))),
      ...entries
        .map((entry) => entry.description)
        .filter((text) => RETIRED.some((pattern) => pattern.test(text))),
    ];
    expect(hits).toEqual([]);
  });

  it("a page body is registered only for a page the tree has", () => {
    for (const key of Object.keys(HELP_BODIES)) {
      const [sectionSlug = "", pageSlug = ""] = key.split("/");
      const section = findHelpSection(sectionSlug);
      expect(section, key).toBeDefined();
      if (section !== undefined)
        expect(findHelpPage(section, pageSlug), key).toBeDefined();
    }
  });
});
