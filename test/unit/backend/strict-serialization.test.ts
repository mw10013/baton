import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Rpc, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import { strictCodecJson } from "../../../src/backend/strict-serialization.ts";
import { CreateWorkflowInput, WorkflowResult } from "../../../src/domain/shop-work.ts";

const Payload = Schema.Struct({
  name: Schema.String,
  note: Schema.optional(Schema.String),
  at: Schema.Date,
  inner: Schema.Struct({ id: Schema.Number }),
});

/** Decodes as `RpcServer` decodes a payload: the codec alone, no parse options. */
const decode = (input: unknown) => Schema.decodeUnknownExit(strictCodecJson(Payload))(input);

describe("strictCodecJson", () => {
  it("accepts a declared payload, decoded as the JSON codec decodes it", () => {
    const input = { name: "a", note: null, at: "2026-10-18T00:00:00.000Z", inner: { id: 1 } };
    const exit = decode(input);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepStrictEqual(exit, Schema.decodeUnknownExit(Schema.toCodecJson(Payload))(input));
  });

  it("refuses a key the payload does not declare", () => {
    const exit = decode({ name: "a", at: "2026-10-18T00:00:00.000Z", inner: { id: 1 }, extra: 1 });
    assert.isTrue(Exit.isFailure(exit));
  });

  it("refuses a key a nested struct does not declare", () => {
    const exit = decode({ name: "a", at: "2026-10-18T00:00:00.000Z", inner: { id: 1, extra: 1 } });
    assert.isTrue(Exit.isFailure(exit));
  });

  it("refuses an excess key on a procedure's domain input", () => {
    const strict = Schema.decodeUnknownExit(strictCodecJson(CreateWorkflowInput));
    assert.isTrue(Exit.isSuccess(strict({ name: "W", tag: "w" })));
    assert.isTrue(Exit.isFailure(strict({ name: "W", tag: "w", extra: 1 })));
  });

  it.effect("encodes a procedure's exit exactly as the JSON codec does", () =>
    Effect.gen(function* () {
      const rpc = Rpc.make("Create", { payload: CreateWorkflowInput, success: WorkflowResult });
      const exitSchema = Rpc.exitSchema(rpc);
      const exit = Exit.succeed({
        _tag: "NameTaken" as const,
        name: Schema.decodeUnknownSync(CreateWorkflowInput)({ name: "W", tag: "w" }).name,
      });
      const strict = yield* Schema.encodeEffect(strictCodecJson(exitSchema))(exit);
      const plain = yield* Schema.encodeEffect(RpcSerialization.json.codecFor(exitSchema))(exit);
      assert.deepStrictEqual(strict, plain);
      // The client decodes it with the plain JSON codec.
      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(RpcSerialization.json.codecFor(exitSchema))(strict),
        exit,
      );
    }),
  );
});
