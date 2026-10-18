import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { lenientSearchKey } from "../../../../src/web/routes/-search-params.ts";

/** Legacy `search-params.test.ts`'s two titles over any key (its flag title has no key here). */
const Search = Schema.Struct({ status: lenientSearchKey(Schema.Literals(["on", "off"])) });
const decode = Schema.decodeUnknownSync(Search);

describe("lenientSearchKey", () => {
  it("an unreadable value reads as absent, as an explicit undefined that replaces the raw text", () => {
    const decoded = decode({ status: "nonsense" });
    expect(decoded).toStrictEqual({ status: undefined });
    expect({ status: "nonsense", ...decoded }.status).toBeUndefined();
  });

  it("a readable value decodes, and an absent key stays absent", () => {
    expect(decode({ status: "on" })).toStrictEqual({ status: "on" });
    expect(decode({})).toStrictEqual({});
  });
});
