import { test as setup } from "./fixtures.ts";
import { signInWithForm } from "./screens.ts";

for (const [role, email, landing] of [
  ["admin", "a@a.com", /\/admin$/],
  ["member", "m1@m.com", /\/shop\/[^/]+\/workflows$/],
] as const)
  setup(`sign in ${role}`, async ({ page }) => {
    await signInWithForm(page, email);
    await page.waitForURL(landing);
    await page.context().storageState({ path: `playwright/.auth/${role}.json` });
  });
