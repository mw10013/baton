import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HELP_BODIES } from "@/components/help/bodies";
import { findHelpPage, findHelpSection, HELP_SECTIONS } from "@/lib/helpPages";
import {
  HELP_PICTURES,
  HELP_PICTURES_PATH,
  helpPictureSrc,
} from "@/lib/helpPictures";

import { RETIRED } from "../../scripts/lib/rules-lint.ts";

/**
 * The help tree (`HELP_SECTIONS` in `src/lib/helpPages.ts`) and the bodies
 * registered against it. The retired-word lint reads `src/lib/helpPages.ts`
 * a line at a time; this test reads each title and summary whole, as the
 * screen shows it, so its copy is pinned here too.
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

  /**
   * The inventory and the files agree both ways (`HELP_PICTURES` in
   * `src/lib/helpPictures.ts`): a lazy glob lists the files without loading
   * them, so a picture the script stopped writing, or a file left behind
   * when an entry was cut, fails here rather than as a broken image.
   */
  it("every picture in the inventory is a file under public/assets/help, and every file there is in the inventory", () => {
    const files = Object.keys(import.meta.glob("/public/assets/help/**/*")).map(
      (file) => file.slice(`/public${HELP_PICTURES_PATH}/`.length),
    );
    const entries = Object.values(HELP_PICTURES).map((picture) => picture.file);
    expect(files.toSorted()).toEqual(entries.toSorted());
  });

  /**
   * Read off the bodies as they render, through the screenshot part, so a
   * body that names a picture places it and nothing else counts.
   */
  it("every picture in the inventory is placed by a help page body", () => {
    const markup = Object.values(HELP_BODIES)
      .map((Body) => renderToStaticMarkup(createElement(Body)))
      .join("");
    const unplaced = Object.entries(HELP_PICTURES)
      .filter(
        ([, picture]) => !markup.includes(`src="${helpPictureSrc(picture)}"`),
      )
      .map(([name]) => name);
    expect(unplaced).toEqual([]);
  });

  /**
   * A merchant picture's `aspectRatio` is its clip in CSS px
   * (`HelpPicture.aspectRatio` in `src/lib/helpPictures.ts`), shot at 2x, so
   * it is half the file's pixel size. A PNG's width and height are bytes 16
   * to 23, big-endian, in its IHDR chunk. The files come in through Vite's
   * `?inline` query as data URLs, the one way to their bytes inside workerd,
   * which has no file system.
   */
  it("a merchant picture's aspect ratio is its file's", async () => {
    const files = import.meta.glob<string>("/public/assets/help/**/*.png", {
      query: "?inline",
      import: "default",
    });
    const merchant = Object.entries(HELP_PICTURES).flatMap(([name, picture]) =>
      picture.kind === "merchant" ? [{ name, picture }] : [],
    );
    for (const { name, picture } of merchant) {
      const load = files[`/public${helpPictureSrc(picture)}`];
      expect(load, name).toBeDefined();
      const dataUrl = (await load?.()) ?? "";
      const bytes = Uint8Array.from(
        atob(dataUrl.slice(dataUrl.indexOf(",") + 1)),
        (char) => char.codePointAt(0) ?? 0,
      );
      const view = new DataView(bytes.buffer);
      expect(picture.aspectRatio, name).toBe(
        `${String(view.getUint32(16) / 2)}/${String(view.getUint32(20) / 2)}`,
      );
    }
  });

  it("every picture's alt text is 30 to 60 words", () => {
    for (const [name, picture] of Object.entries(HELP_PICTURES)) {
      const words = picture.alt.split(/\s+/u).filter((word) => word !== "");
      expect(words.length, name).toBeGreaterThanOrEqual(30);
      expect(words.length, name).toBeLessThanOrEqual(60);
    }
  });
});
