import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { lenientSearchKey } from "@/lib/searchParams";

const Search = Schema.Struct({
  status: lenientSearchKey(Schema.Literals(["on", "off"])),
});
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

  it("a flag key reads 1 as on and anything else as absent, as the orders index's ?issues= does", () => {
    const Flag = Schema.Struct({ issues: lenientSearchKey(Schema.Literal(1)) });
    const decodeFlag = Schema.decodeUnknownSync(Flag);
    expect(decodeFlag({ issues: 1 })).toStrictEqual({ issues: 1 });
    for (const value of [0, "1", true, "yes"])
      expect(decodeFlag({ issues: value })).toStrictEqual({
        issues: undefined,
      });
    expect(decodeFlag({})).toStrictEqual({});
  });
});
