import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { HELP_BODIES } from "../../../../../src/web/components/help/bodies.tsx";
import {
  findHelpPage,
  findHelpSection,
  HELP_SECTIONS,
} from "../../../../../src/web/components/help/pages.ts";
import {
  HELP_PICTURES,
  HELP_PICTURES_PATH,
  helpPictureSrc,
} from "../../../../../src/web/components/help/pictures.ts";

/** The help tree (`HELP_SECTIONS`), the bodies registered against it, and the pictures. */

const SLUG = /^[a-z0-9-]+$/u;

/** Where the pictures live on disk, under `public/`. */
const PICTURES_DIR = path.join("public", HELP_PICTURES_PATH);

/** Every file under the pictures folder, as a path relative to it. */
const pictureFiles = (): readonly string[] =>
  readdirSync(PICTURES_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(PICTURES_DIR, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );

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

  /**
   * The inventory and the files agree both ways: a picture the script stopped writing, or a file
   * left behind when an entry was cut, fails here rather than as a broken image.
   */
  it("every picture in the inventory is a file under public/assets/help, and every file there is in the inventory", () => {
    const entries = Object.values(HELP_PICTURES).map((picture) => picture.file);
    expect(pictureFiles().toSorted()).toEqual(entries.toSorted());
  });

  /** Read off the bodies as they render, through the picture part, so only a placement counts. */
  it("every picture in the inventory is placed by a help page body", () => {
    const markup = Object.values(HELP_BODIES)
      .map((Body) => renderToStaticMarkup(createElement(Body)))
      .join("");
    const unplaced = Object.entries(HELP_PICTURES)
      .filter(([, picture]) => !markup.includes(`src="${helpPictureSrc(picture)}"`))
      .map(([name]) => name);
    expect(unplaced).toEqual([]);
  });

  /**
   * A merchant picture's `aspectRatio` is its clip in CSS px, shot at 2x, so it is half the
   * file's pixel size. A PNG's width and height are bytes 16 to 23, big-endian, in its IHDR chunk.
   */
  it("a merchant picture's aspect ratio is its file's", () => {
    for (const [name, picture] of Object.entries(HELP_PICTURES)) {
      if (picture.kind !== "merchant") continue;
      const bytes = readFileSync(path.join(PICTURES_DIR, picture.file));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
