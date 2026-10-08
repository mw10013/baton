import { expect, test } from "@playwright/test";

import { HELP_BODIES } from "@/components/help/bodies";
import { findHelpPage, findHelpSection, HELP_SECTIONS } from "@/lib/helpPages";
import { HELP_PICTURES_PATH } from "@/lib/helpPictures";

import { gotoMember } from "./member";

/**
 * The public help (`/help`), outside the embedded app and the member area: no
 * sign-in and no seed, so the `public` project runs it with empty storage
 * state against `http://localhost:$PORT`. The tree it walks is
 * `HELP_SECTIONS`, the one source the routes read.
 */

test("the hub lists every section", async ({ page }) => {
  await gotoMember(page, "/help");
  await expect(page.locator('s-page[heading="Help"]')).toBeVisible();
  for (const section of HELP_SECTIONS)
    await expect(
      page.locator(`s-link[href="/help/${section.slug}"]`, {
        hasText: section.title,
      }),
    ).toBeVisible();
});

test("a section hub lists its pages and a page's foot lists its siblings", async ({
  page,
}) => {
  for (const section of HELP_SECTIONS) {
    const sectionHref = `/help/${section.slug}`;
    await gotoMember(page, sectionHref);
    await expect(
      page.locator(`s-page[heading="${section.title}"]`),
    ).toBeVisible();
    for (const entry of section.pages)
      await expect(
        page.locator(`s-link[href="${sectionHref}/${entry.slug}"]`),
      ).toBeVisible();

    const [first, ...siblings] = section.pages;
    if (first === undefined) throw new Error(`${section.slug} has no pages`);
    await gotoMember(page, `${sectionHref}/${first.slug}`);
    await expect(
      page.locator(`s-page[heading="${first.title}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`s-link[slot="breadcrumb-actions"][href="${sectionHref}"]`),
    ).toBeAttached();
    /* The foot list is the page's last section: a body may link a sibling
       too, so the sibling links are looked for in the foot alone. */
    const foot = page.locator("s-section").last();
    await expect(
      foot.locator(`s-heading s-link[href="${sectionHref}"]`),
    ).toBeVisible();
    await expect(
      foot.locator('s-list-item s-text[type="strong"]', {
        hasText: first.title,
      }),
    ).toBeVisible();
    await expect(
      foot.locator(`s-link[href="${sectionHref}/${first.slug}"]`),
    ).toHaveCount(0);
    for (const sibling of siblings)
      await expect(
        foot.locator(`s-link[href="${sectionHref}/${sibling.slug}"]`),
      ).toBeVisible();
  }
});

test("an unknown page is not found", async ({ page }) => {
  await gotoMember(page, "/help/workflows/nope");
  await expect(page.locator('s-page[heading="Page not found"]')).toBeVisible();
  await expect(
    page.locator('s-section s-link[href="/help"]', { hasText: "Help" }),
  ).toBeVisible();
});

test("the landing page links to help", async ({ page }) => {
  await gotoMember(page, "/");
  await expect(page.locator('s-link[href="/help"]').first()).toBeVisible();
});

test("the sign-in page links to Signing in", async ({ page }) => {
  await gotoMember(page, "/login");
  await expect(
    page.locator('s-link[href="/help/members/signing-in"]', {
      hasText: "Signing in",
    }),
  ).toBeVisible();
});

/**
 * Each page with a body (a `HELP_BODIES` key, read here so a section is
 * covered as soon as its bodies are registered) renders it: sections with
 * headings, which the lead and the foot list have none of. Every picture the
 * body places loads, wherever the inventory files it: a body may place a
 * picture first taken for another page. `naturalWidth` is the browser's word
 * that the file arrived and decoded; a missing file still draws an
 * `s-image` box.
 */
test("each page with a body renders it and its pictures load", async ({
  page,
}) => {
  for (const key of Object.keys(HELP_BODIES)) {
    const [sectionSlug = "", pageSlug = ""] = key.split("/");
    const section = findHelpSection(sectionSlug);
    const entry =
      section === undefined ? undefined : findHelpPage(section, pageSlug);
    if (entry === undefined) throw new Error(`${key} is not in the tree`);
    await gotoMember(page, `/help/${key}`);
    await expect(
      page.locator(`s-page[heading="${entry.title}"]`),
    ).toBeVisible();
    await expect(page.locator("s-section[heading]").first()).toBeVisible();
    const pictures = page.locator(`s-image[src^="${HELP_PICTURES_PATH}/"]`);
    const count = await pictures.count();
    for (let index = 0; index < count; index += 1) {
      const picture = pictures.nth(index);
      const src = await picture.getAttribute("src");
      const image = picture.locator("img");
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(
          () => image.evaluate((img: HTMLImageElement) => img.naturalWidth),
          { message: `${key}: ${src ?? ""} loads` },
        )
        .toBeGreaterThan(0);
    }
  }
});
