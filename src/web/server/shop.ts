import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { homeFor } from "../client/session.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/**
 * The signed-in member's shops. The `/shop` guard has already sent everyone else away; one who
 * signed out since goes to sign-in and back, and an admin to its own home.
 */
export const listMyShops = createServerFn({ method: "GET" }).handler(() =>
  backend()
    .myShops(requestInfo())
    .catch(
      rescue(Schema.Union([Unauthorized, Forbidden]), (failure) =>
        Match.valueTags(failure, {
          Unauthorized: () => {
            throw redirect({
              to: "/sign-in",
              search: { redirect: Option.getOrUndefined(decodeReturnPath("/shop")) },
            });
          },
          Forbidden: () => {
            throw redirect({ to: homeFor("admin") });
          },
        }),
      ),
    ),
);
