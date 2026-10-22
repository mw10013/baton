import { assert, describe, it } from "@effect/vitest";

import {
  muxArgs,
  narrationArgs,
  overlaps,
  type PlacedClip,
  placeClips,
} from "../../../../scripts/lib/screencast-build.ts";
import { GAP_MS, paneCrop, sceneEnd } from "../../../../scripts/lib/screencast-take.ts";

const clip = (id: string, startMs: number, durationMs: number): PlacedClip => ({
  id,
  file: `/v/${id}.mp3`,
  startMs,
  durationMs,
});

describe("sceneEnd", () => {
  it("waits for the line when the action is quicker, then the gap", () => {
    assert.strictEqual(sceneEnd(1000, 2000, 4000), 5000 + GAP_MS);
  });

  it("waits for the action when it outlasts the line", () => {
    assert.strictEqual(sceneEnd(1000, 9000, 4000), 9000 + GAP_MS);
  });
});

describe("placeClips", () => {
  it("puts each scene's clip at the scene's start, rounded to a millisecond", () => {
    const placed = placeClips(
      [{ id: "a", startMs: 6240.4, voiceMs: 3000, endMs: 9900 }],
      [{ id: "a", key: "k", durationMs: 3000 }],
    );
    assert.strictEqual(placed[0]?.startMs, 6240);
    assert.isTrue(placed[0]?.file.endsWith("/k.mp3"));
  });
});

describe("overlaps", () => {
  it("names a line that runs into the next one", () => {
    assert.deepStrictEqual(overlaps([clip("a", 0, 5000), clip("b", 4800, 1000)]), [
      "a runs 200 ms into b",
    ]);
  });

  it("finds none when every line ends before the next starts", () => {
    assert.deepStrictEqual(overlaps([clip("a", 0, 4000), clip("b", 4600, 1000)]), []);
  });
});

describe("narrationArgs", () => {
  it("delays each clip to its start with timestamps rebuilt around adelay, then mixes and trims", () => {
    const args = narrationArgs([clip("a", 6240, 3000), clip("b", 19610, 2000)], 171600, "/n.wav");
    const graph = args[args.indexOf("-filter_complex") + 1];
    assert.include(
      graph,
      "[0:a]aresample=48000,asetpts=N/SR/TB,adelay=6240:all=1,asetpts=N/SR/TB[a0]",
    );
    assert.include(graph, "adelay=19610:all=1");
    assert.include(graph, "[a0][a1]amix=inputs=2:normalize=0");
    assert.include(graph, "atrim=0:171.600[out]");
    assert.deepStrictEqual(args.slice(-1), ["/n.wav"]);
  });
});

describe("muxArgs", () => {
  it("scales to 1080p and cuts to the take's length", () => {
    const args = muxArgs("/raw.webm", "/n.wav", undefined, 171600, "/out.mp4");
    assert.include(args, "scale=1920:1080:flags=lanczos");
    assert.include(args, "1:a");
    assert.strictEqual(args[args.indexOf("-t") + 1], "171.600");
  });

  it("crops a pane take before scaling it", () => {
    const args = muxArgs(
      "/raw.webm",
      "/n.wav",
      { x: 240, y: 56, width: 1280, height: 720 },
      1000,
      "/out.mp4",
    );
    assert.include(args, "crop=1280:720:240:56,scale=1920:1080:flags=lanczos");
  });

  it("makes a silent video from a rehearsal", () => {
    const args = muxArgs("/raw.webm", undefined, undefined, 1000, "/out.mp4");
    assert.notInclude(args, "1:a");
    assert.strictEqual(args.filter((arg) => arg === "-i").length, 1);
  });
});

describe("paneCrop", () => {
  it("stays 16:9 inside a 16:9 pane", () => {
    const crop = paneCrop({ x: 240, y: 56, width: 1280, height: 720 });
    assert.deepStrictEqual(crop, { x: 256, y: 65, width: 1248, height: 702 });
    assert.strictEqual(crop.width * 9, crop.height * 16);
  });
});
