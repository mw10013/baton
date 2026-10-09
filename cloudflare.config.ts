/**
 * Account default for ad hoc `cf` API tests and experiments only.
 * This is independent of the app's existing Wrangler/Vite setup, which still
 * uses `wrangler.jsonc`. It does not define a Worker or migrate deployment.
 * Credentials come from `CLOUDFLARE_API_TOKEN` in the shell environment.
 */
export default {
  accountId: "87997fc2724b0127effb8e4524989975",
};
