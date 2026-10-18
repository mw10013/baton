import type { Page } from "playwright/test";
import { awaitHydration, expect } from "./fixtures.ts";

export const signIn = (page: Page) => ({
  email: page.getByLabel("Email"),
  send: page.getByRole("button", { name: "Send link" }),
  checkEmail: page.getByRole("heading", { name: "Check your email" }),
  openLink: page.getByRole("link", { name: "Open link" }),
});

export const shell = (page: Page) => ({
  signOut: page.getByRole("button", { name: "Sign out" }),
  members: page.getByRole("link", { name: "Members" }),
});

/** The member shop layout: its socket banner and its "No access" page. */
export const memberShop = (page: Page) => ({
  workflows: page.locator('s-section[accessibilityLabel="Workflows"]'),
  signedInElsewhere: page.getByText("Signed in elsewhere"),
  reconnect: page.getByRole("button", { name: "Reconnect" }),
  noAccess: page.getByText("You no longer have access to this store."),
});

/** Submits the sign-in form on a hydrated `/sign-in` and waits for the confirmation. */
export const requestMagicLink = async (page: Page, email: string) => {
  const screen = signIn(page);
  await screen.email.fill(email);
  await screen.send.click();
  await expect(screen.checkEmail).toBeVisible();
};

/**
 * Signs `email` in as a person would: fills `/sign-in`, then opens the link the page shows (inline
 * delivery, which `alchemy dev` uses), and waits for the page the verify redirect lands on. The
 * caller asserts which page that is.
 */
export const signInWithForm = async (page: Page, email: string) => {
  await page.goto("/sign-in");
  await awaitHydration(page);
  await requestMagicLink(page, email);
  await signIn(page).openLink.click();
  await page.waitForURL(/\/(?:shop(?:\/[^/]+\/workflows)?|admin)$/u);
  await awaitHydration(page);
};
