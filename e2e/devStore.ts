import { readFileSync } from "node:fs";

/**
 * The URLs a run targets, all derived from this checkout's `.env`
 * (`playwright.config.ts` loads it): `PORT` for the app served straight off
 * localhost, `SHOPIFY_DEV_STORE` for the store the app is installed on. Each
 * checkout (git worktree) has its own pair, so nothing here is hard-coded.
 */

const required = (key: "PORT" | "SHOPIFY_DEV_STORE") => {
  const value = process.env[key];
  if (value === undefined || value === "")
    throw new Error(`E2E requires ${key} in .env.`);
  return value;
};

/** `http://localhost:$PORT`, the member area, the operator console and the seed endpoint. */
export const localUrl = () => `http://localhost:${required("PORT")}`;

/** `<SHOPIFY_DEV_STORE>.myshopify.com`, the shop the seed writes to. */
export const devShop = () => `${required("SHOPIFY_DEV_STORE")}.myshopify.com`;

/** `handle` in `shopify.app.toml`, the app's path segment in the admin. */
const appHandle = () => {
  const handle = /^handle\s*=\s*"(?<handle>[^"]+)"/mu.exec(
    readFileSync("shopify.app.toml", "utf8"),
  )?.groups?.handle;
  if (handle === undefined) throw new Error("no handle in shopify.app.toml");
  return handle;
};

/** The embedded app's admin URL: `https://admin.shopify.com/store/<store>/apps/<handle>/app`. */
export const previewUrl = () =>
  `https://admin.shopify.com/store/${required("SHOPIFY_DEV_STORE")}/apps/${appHandle()}/app`;
