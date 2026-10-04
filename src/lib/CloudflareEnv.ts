import { Context } from "effect";

export const CloudflareEnv = Context.Service<Env>("CloudflareEnv");

/**
 * Whether the object writes its timing and fan-out lines (`ShopAgent.publish`,
 * `ShopAgent.readOrders`, `ShopAgent.readRuns`). On for local and staging, off
 * for production: the lines are one per read and one per publish, which on a
 * busy shop is the object's busiest log stream, and the question they answer
 * (how often the subscribed screens refetch and how long each read takes) is
 * asked on staging.
 */
export const instrumentationIsOn = (environment: Env["ENVIRONMENT"]) =>
  environment === "local" || environment === "staging";
