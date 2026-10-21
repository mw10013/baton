#!/usr/bin/env node
/**
 * `vp run fixture`: puts this checkout's dev store back into the dev fixture; see
 * {@link applyFixture}. The dev server must be running (`vp run dev`), and the app must have been
 * opened in the store once, which is what installs it on this stage. `vp run db:reset` runs the
 * same after opening the app itself.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";

import { fixture } from "../fixture.ts";
import { applyFixture } from "./lib/fixture.ts";

applyFixture({ fixture, waitForInstall: false }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
