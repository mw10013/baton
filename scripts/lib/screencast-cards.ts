/**
 * The screencasts' cards and the feature video's thumbnail, as HTML: Baton's icon and type on its
 * own blue, with no Shopify mark. A card is drawn over the admin's top document during a take
 * ({@link cardHtml}); the thumbnail is the same title card on its own page, shot by Chrome
 * ({@link renderThumbnail}).
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import type { Card } from "./screencast.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The icon's own fill, so a card and the icon read as one brand. */
const BRAND_BLUE = "#1F4FD8";
/** Single-quoted: it goes inside a double-quoted `style` attribute. */
const FONT = `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
/** The listing form's feature-media size, for the thumbnail and its alternative, a feature image. */
export const THUMBNAIL = { width: 1600, height: 900 } as const;

/**
 * Files as data URLs: the take's page is `admin.shopify.com`, which can't load a local file, so
 * a card carries its images inline.
 */
const dataUrl = (file: string, type: string) =>
  `data:${type};base64,${readFileSync(file, "base64")}`;

const icon = () => dataUrl(resolve(REPO_ROOT, "public/app-icon.svg"), "image/svg+xml");

/**
 * A card's markup at `size` CSS px: a block that fills its box, its type scaled to the box's
 * height so the take's card and the thumbnail are one design at two sizes.
 */
export const cardHtml = (card: Card, size: { readonly width: number; readonly height: number }) => {
  const u = size.height / 720;
  const px = (n: number) => `${Math.round(n * u)}px`;
  const box = `width:${size.width}px;height:${size.height}px;background:${BRAND_BLUE};display:flex;align-items:center;justify-content:center;font-family:${FONT};color:#fff;box-sizing:border-box`;
  return Match.value(card).pipe(
    Match.tag(
      "Title",
      ({ title, line }) => `<div style="${box};flex-direction:column;gap:${px(20)}">
  <img src="${icon()}" alt="" style="width:${px(132)};height:${px(132)};border-radius:${px(30)};box-shadow:0 0 0 ${px(3)} rgba(255,255,255,.35),0 ${px(18)} ${px(48)} rgba(0,0,0,.25)">
  <div style="font-size:${px(96)};font-weight:700;letter-spacing:-.02em;line-height:1;margin-top:${px(16)}">${title}</div>
  <div style="font-size:${px(36)};font-weight:500;opacity:.9;line-height:1.2">${line}</div>
</div>`,
    ),
    Match.tag(
      "Phones",
      ({ files }) => `<div style="${box};gap:${px(32)}">
${files
  .map(
    (file) =>
      `  <img src="${dataUrl(resolve(REPO_ROOT, "public/assets/help", file), "image/png")}" alt="" style="width:${px(360)};height:${px(600)};object-fit:cover;object-position:top;border-radius:${px(28)};background:#fff;box-shadow:0 ${px(18)} ${px(48)} rgba(0,0,0,.3)">`,
  )
  .join("\n")}
</div>`,
    ),
    Match.exhaustive,
  );
};

/** Writes `card` as a {@link THUMBNAIL}-sized PNG, rendered by Chrome. */
export const renderThumbnail = Effect.fn("renderThumbnail")(function* (card: Card, output: string) {
  yield* Effect.promise(async () => {
    await mkdir(dirname(output), { recursive: true });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({ viewport: THUMBNAIL });
      await page.setContent(
        `<!doctype html><html><body style="margin:0">${cardHtml(card, THUMBNAIL)}</body></html>`,
      );
      await page.screenshot({ path: output });
    } finally {
      await browser.close();
    }
  });
});
