import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "./env.server.ts";

/**
 * The kit page's gate, for its `beforeLoad`: not found unless the stage binds `DEV_KIT` on, so
 * the kit exists only where the stage's data is disposable. The Website has no other environment
 * binding to read, so the stack sets this one beside the Backend's `DEV_ENDPOINT`.
 */
export const requireDevKit = createServerFn({ method: "GET" }).handler(() => {
  if (env.DEV_KIT !== "on") throw notFound();
  return null;
});
