import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { lenientSearchKey } from "@/lib/searchParams";

const Search = Schema.Struct({
  status: lenientSearchKey(Schema.Literals(["active", "inactive"])),
});
const decode = Schema.decodeUnknownSync(Search);

describe("lenientSearchKey", () => {
  it("an unreadable value reads as absent, as an explicit undefined that replaces the raw text", () => {
    const decoded = decode({ status: "nonsense" });
    expect(decoded).toStrictEqual({ status: undefined });
    expect({ status: "nonsense", ...decoded }.status).toBeUndefined();
  });

  it("a readable value decodes, and an absent key stays absent", () => {
    expect(decode({ status: "active" })).toStrictEqual({ status: "active" });
    expect(decode({})).toStrictEqual({});
  });
});
