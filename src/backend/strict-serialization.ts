import * as Layer from "effect/Layer";
import { RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * `Schema.toCodecJson(schema)` whose decoding refuses a key the schema does not declare, at
 * any depth, while encoding is unchanged.
 *
 * Effect's decoders strip excess keys unless the call passes `onExcessProperty: "error"`, and
 * an annotation cannot override a call's options; `RpcServer` decodes payloads with no options.
 * So the codec is a transformation from `unknown` whose decode re-enters the parser with the
 * caller's options plus `onExcessProperty: "error"`.
 */
export const strictCodecJson: RpcSerialization.CodecFor = (schema) => {
  const codec = Schema.toCodecJson(schema);
  const decode = SchemaParser.decodeUnknownEffect(codec);
  const encode = SchemaParser.encodeEffect(codec);
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.toType(codec),
      SchemaTransformation.transformEffect({
        decode: (input, options) => decode(input, { ...options, onExcessProperty: "error" }),
        encode: (value, options) => encode(value, options),
      }),
    ),
  );
};

/**
 * {@link RpcSerialization.json} with {@link strictCodecJson}: a procedure refuses a payload
 * carrying a key its schema does not declare, as legacy's callables did, rather than running
 * with the key stripped. The refusal is a defect on that request's exit. Server side only:
 * clients encode from the payload's type, so they keep `RpcSerialization.layerJson`.
 */
export const layerStrictJson = Layer.succeed(RpcSerialization.RpcSerialization, {
  ...RpcSerialization.json,
  codecFor: strictCodecJson,
});
