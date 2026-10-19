import { describe, expect, it } from "vite-plus/test";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import type { MagicLinkResult } from "../../../../src/web/server/sign-in.ts";
import SignInPage from "../../../../src/web/components/SignInPage.tsx";

const requestLink = async (screen: Awaited<ReturnType<typeof renderInApp>>, email: string) => {
  await screen.getByLabelText("Email").fill(email);
  await screen.getByRole("button", { name: "Send link" }).click();
};

const render = (requestMagicLink: (input: { email: string }) => Promise<MagicLinkResult>) =>
  renderInApp(
    <SignInPage returnTo={undefined} error={undefined} requestMagicLink={requestMagicLink} />,
    shopTestRegistry({}),
  );

describe("SignInPage", () => {
  it("shows the inline link after a request, with the email decoded", async () => {
    const requested: Array<string> = [];
    const screen = await render(async ({ email }) => {
      requested.push(email);
      return { _tag: "Sent", link: "http://test.local/verify" };
    });

    await requestLink(screen, " M1@m.com ");

    await expect.element(screen.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open link" }))
      .toHaveAttribute("href", "http://test.local/verify");
    expect(requested).toEqual(["m1@m.com"]);
  });

  it("says when the rate limit is hit", async () => {
    const screen = await render(async () => ({ _tag: "TooManyRequests" }));

    await requestLink(screen, "m1@m.com");

    await expect
      .element(screen.getByText("Too many attempts. Try again in a minute."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Send link" })).toBeVisible();
  });

  it("says when the request fails", async () => {
    const screen = await render(() => Promise.reject(new Error("unreachable")));

    await requestLink(screen, "m1@m.com");

    await expect.element(screen.getByText("Something went wrong. Try again.")).toBeVisible();
  });

  it("links to Signing in until the link is sent", async () => {
    const screen = await render(async () => ({ _tag: "Sent", link: undefined }));

    await expect
      .element(screen.getByRole("link", { name: "Signing in" }))
      .toHaveAttribute("href", "/help/members/signing-in");

    await requestLink(screen, "m1@m.com");

    await expect.element(screen.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Signing in" })).not.toBeInTheDocument();
  });
});
