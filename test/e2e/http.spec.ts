import { expect, test } from "./fixtures.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

/**
 * The Website's HTTP behavior, through the `request` fixture alone: no page, so no browser. The
 * guards run in `beforeLoad` during SSR, so their redirects are plain HTTP redirects. The
 * `request` fixture carries the project's `storageState`, so a signed-in request uses the
 * member's, saved by the sign-in setup.
 */
test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a signed-out request to the member area redirects to sign-in", async ({ request }) => {
    const response = await request.get("/shop", { maxRedirects: 0 });
    expect(response.headers().location).toBe("/sign-in?redirect=%2Fshop");
  });

  test("an anonymous visitor is bounced from /admin to /sign-in", async ({ request }) => {
    const response = await request.get("/admin", { maxRedirects: 0 });
    expect(response.headers().location).toBe("/sign-in?redirect=%2Fadmin");
  });

  test("an anonymous visitor is bounced from /admin/shops to /sign-in", async ({ request }) => {
    const response = await request.get("/admin/shops", { maxRedirects: 0 });
    expect(response.headers().location).toBe("/sign-in?redirect=%2Fadmin%2Fshops");
  });
});

test.describe("as a member", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("a member of one shop is sent past Your stores to its workflows list", async ({
    request,
  }) => {
    const response = await request.get("/shop", { maxRedirects: 0 });
    expect(response.headers().location).toBe(`/shop/${E2E_SHOP}/workflows`);
  });

  test("a signed-in member's request to their shop returns HTML", async ({ request }) => {
    const response = await request.get(`/shop/${E2E_SHOP}/workflows`, { maxRedirects: 0 });
    expect(response.headers()["content-type"]).toContain("text/html");
  });

  test("a member's request to the admin area is sent to the member area", async ({ request }) => {
    const response = await request.get("/admin", { maxRedirects: 0 });
    expect(response.headers().location).toBe("/shop");
  });

  test("the auth proxy serves only verify and sign-out: get-session is not found", async ({
    request,
  }) => {
    const response = await request.get("/api/auth/get-session");
    expect(response.status()).toBe(404);
  });
});
