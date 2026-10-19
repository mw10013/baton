import { describe, expect, it } from "vite-plus/test";
import { HELP_BODIES } from "../../../../../src/web/components/help/bodies.tsx";
import {
  findHelpPage,
  findHelpSection,
  HELP_SECTIONS,
} from "../../../../../src/web/components/help/pages.ts";

/** The help tree (`HELP_SECTIONS`) and the bodies registered against it. */

const SLUG = /^[a-z0-9-]+$/u;

const unique = (values: readonly string[]) => new Set(values).size === values.length;

describe("help pages", () => {
  it("every help page has a unique route and a title that is its heading", () => {
    expect(unique(HELP_SECTIONS.map((section) => section.slug))).toBe(true);
    for (const section of HELP_SECTIONS) {
      expect(unique(section.pages.map((page) => page.slug))).toBe(true);
      for (const entry of [section, ...section.pages]) {
        expect(entry.slug).toMatch(SLUG);
        expect(entry.title).not.toBe("");
        expect(entry.description).not.toBe("");
        expect(entry.title.endsWith(".")).toBe(false);
        expect(entry.title.endsWith("?")).toBe(false);
      }
    }
  });

  it("a page body is registered only for a page the tree has", () => {
    for (const key of Object.keys(HELP_BODIES)) {
      const [sectionSlug = "", pageSlug = ""] = key.split("/");
      const section = findHelpSection(sectionSlug);
      expect(section, key).toBeDefined();
      if (section !== undefined) expect(findHelpPage(section, pageSlug), key).toBeDefined();
    }
  });
});
