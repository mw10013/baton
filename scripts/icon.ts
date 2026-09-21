/**
 * Draws the Baton mark and writes every artifact that carries it:
 * `public/app-icon.svg`, `public/app-icon.png`, `public/favicon.svg`, and
 * `src/components/BatonMark.tsx`. Run with `pnpm icon`.
 *
 * The mark is generated rather than drawn by hand because the whooshes are
 * calligraphic outlines - closed shapes swelling to a belly and closing to a
 * point at both ends - sampled from a centreline and a width curve. Their path
 * data is machine output and cannot be meaningfully hand-edited, so editing the
 * mark means editing {@link VARIANTS} and re-running. Hand-patching one of the
 * four artifacts instead is how the app ends up showing two different marks in
 * the same browser tab.
 *
 * The PNG is rasterised with headless Chrome, not ImageMagick: the `magick`
 * builds on macOS commonly have no `rsvg-convert` delegate and fall back to
 * their own SVG renderer, which silently drops `transform` attributes and emits
 * a bare background tile with no error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * The palette. `GROUND` is chosen to separate from both admin backgrounds the
 * icon is composited on, `#FFFFFF` and `#F1F1F1`; `BATON` is the only warm
 * value in the mark, so the eye lands on the object rather than the motion.
 *
 * `AIR_*` are three solid tints stepping from white toward `GROUND`. They are
 * the mark's dissipation, done in block colour on purpose: a real SVG gradient
 * renders as mud at the roughly 20px the Shopify admin navigation uses, while
 * discrete tints drop away cleanly and leave the white stroke carrying the
 * mark. Adding a fourth tint is how the fade turns back into mud.
 */
const GROUND = "#1F4FD8";
const BATON = "#FFC24B";
const AIR_NEAR = "#FFFFFF";
const AIR_MID = "#AFC4F7";
const AIR_FAR = "#6E90EC";

/** Corner radius on the rounded copies, as a fraction of the 1200px canvas. */
const FAVICON_RADIUS = 263;

type Point = readonly [number, number];

/**
 * One calligraphic whoosh: a cubic centreline `p0..p3` with a width that swells
 * to `width` at `belly` (a fraction of the length) and closes to a point at
 * both ends.
 *
 * `belly` and `ease` are the shape's character. A belly at 0.5 with a high
 * `ease` is a symmetric leaf; moving it off centre and softening `ease` gives
 * the asymmetric, brush-drawn stroke the mark wants. Every whoosh in a variant
 * carries a *different* belly, length and arc, because strokes that match each
 * other read as a rigid grille rather than as moving air.
 */
interface Whoosh {
  readonly p0: Point;
  readonly p1: Point;
  readonly p2: Point;
  readonly p3: Point;
  readonly width: number;
  readonly belly: number;
  readonly ease: number;
  readonly fill: string;
}

/**
 * A complete drawing: its whooshes, and the `scale`/`dx`/`dy` that seat the
 * result on Shopify's icon grid.
 *
 * The fit is not cosmetic. Shopify asks for artwork filling 750-900px of the
 * 1200px canvas with at least 75px of clear ground, so a variant whose raw
 * drawing measures 905px tall is out of specification until it is scaled. The
 * numbers here were derived by rendering the raw drawing, measuring its
 * bounding box, and solving for the scale and offset that centre it - see the
 * `fit` note printed by this script, which re-measures on every run.
 */
interface Variant {
  readonly whooshes: readonly Whoosh[];
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
}

const whoosh = (
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  width: number,
  belly: number,
  ease: number,
  fill: string,
): Whoosh => ({ p0, p1, p2, p3, width, belly, ease, fill });

/**
 * Every drawing that has survived review, current one last. They are kept
 * rather than deleted so a later pass can see what the alternatives actually
 * looked like instead of re-deriving them: `slipstream` is `dissipating`
 * without the tint fade, `drift` trades propulsion for calm, and `wisp` bends
 * each stroke into an S so the air curls instead of streaking.
 */
const VARIANTS: Record<string, Variant> = {
  dissipating: {
    whooshes: [
      whoosh(
        [150, 800],
        [300, 618],
        [470, 600],
        [626, 628],
        96,
        0.62,
        0.5,
        AIR_NEAR,
      ),
      whoosh(
        [192, 940],
        [330, 808],
        [470, 786],
        [600, 806],
        74,
        0.54,
        0.56,
        AIR_MID,
      ),
      whoosh(
        [296, 1028],
        [378, 948],
        [470, 932],
        [552, 952],
        52,
        0.46,
        0.6,
        AIR_FAR,
      ),
    ],
    scale: 0.96,
    dx: 58.5,
    dy: 44.6,
  },
  slipstream: {
    whooshes: [
      whoosh(
        [150, 800],
        [300, 618],
        [470, 600],
        [626, 628],
        96,
        0.62,
        0.5,
        AIR_NEAR,
      ),
      whoosh(
        [192, 940],
        [330, 808],
        [470, 786],
        [600, 806],
        74,
        0.54,
        0.56,
        AIR_NEAR,
      ),
      whoosh(
        [296, 1028],
        [378, 948],
        [470, 932],
        [552, 952],
        52,
        0.46,
        0.6,
        AIR_NEAR,
      ),
    ],
    scale: 0.96,
    dx: 58.5,
    dy: 44.6,
  },
  drift: {
    whooshes: [
      whoosh(
        [158, 762],
        [330, 652],
        [460, 624],
        [622, 610],
        88,
        0.68,
        0.52,
        AIR_NEAR,
      ),
      whoosh(
        [196, 906],
        [356, 826],
        [470, 796],
        [604, 786],
        70,
        0.56,
        0.58,
        AIR_NEAR,
      ),
      whoosh(
        [300, 1004],
        [398, 956],
        [464, 942],
        [548, 936],
        50,
        0.44,
        0.62,
        AIR_NEAR,
      ),
    ],
    scale: 0.98,
    dx: 43.4,
    dy: 44.4,
  },
  wisp: {
    whooshes: [
      whoosh(
        [170, 820],
        [300, 600],
        [520, 700],
        [626, 606],
        104,
        0.6,
        0.5,
        AIR_NEAR,
      ),
      whoosh(
        [208, 952],
        [330, 804],
        [490, 876],
        [598, 800],
        78,
        0.54,
        0.55,
        AIR_MID,
      ),
      whoosh(
        [318, 1032],
        [390, 944],
        [486, 988],
        [556, 938],
        52,
        0.46,
        0.6,
        AIR_FAR,
      ),
    ],
    scale: 0.955,
    dx: 52.3,
    dy: 45.7,
  },
};

/** The drawing the four artifacts are built from. */
const CURRENT = "wisp";

/**
 * The baton: one straight capsule, steeper than the air behind it.
 *
 * The angle is the mark's load-bearing detail. A thrown baton tumbles, so it is
 * not aligned with its own travel, and that mismatch is the only thing keeping
 * the whooshes from reading as more batons. Turn `ANGLE` toward the whooshes'
 * shallow run and the mark collapses into a row of parallel bars.
 */
const BATON_CENTRE: Point = [800, 460];
const BATON_ANGLE = -72;
const BATON_LENGTH = 490;
const BATON_WIDTH = 200;

const fixed = (n: number) => n.toFixed(1);

function batonPath(): string {
  const r = (BATON_ANGLE * Math.PI) / 180;
  const dx = (Math.cos(r) * BATON_LENGTH) / 2;
  const dy = (Math.sin(r) * BATON_LENGTH) / 2;
  const [cx, cy] = BATON_CENTRE;
  return (
    `<path d="M ${fixed(cx - dx)} ${fixed(cy - dy)} L ${fixed(cx + dx)} ${fixed(cy + dy)}"` +
    ` fill="none" stroke="${BATON}" stroke-width="${String(BATON_WIDTH)}" stroke-linecap="round"/>`
  );
}

/** Clamped sample, so the curve's first and last knots reuse the endpoint. */
const knot = (points: readonly Point[], i: number): Point =>
  points[Math.min(Math.max(i, 0), points.length - 1)] ?? [0, 0];

/** Catmull-Rom through the sampled outline, so the emitted path is curves. */
function throughPoints(points: readonly Point[]): string {
  let d = "";
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = knot(points, i - 1);
    const p1 = knot(points, i);
    const p2 = knot(points, i + 1);
    const p3 = knot(points, i + 2);
    const c1: Point = [
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
    ];
    const c2: Point = [
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
    ];
    d += ` C ${fixed(c1[0])} ${fixed(c1[1])} ${fixed(c2[0])} ${fixed(c2[1])} ${fixed(p2[0])} ${fixed(p2[1])}`;
  }
  return d;
}

const SAMPLES = 14;

function whooshPath(w: Whoosh): string {
  const at = (t: number): Point => {
    const u = 1 - t;
    return [
      u * u * u * w.p0[0] +
        3 * u * u * t * w.p1[0] +
        3 * u * t * t * w.p2[0] +
        t * t * t * w.p3[0],
      u * u * u * w.p0[1] +
        3 * u * u * t * w.p1[1] +
        3 * u * t * t * w.p2[1] +
        t * t * t * w.p3[1],
    ];
  };
  const tangent = (t: number): Point => {
    const u = 1 - t;
    return [
      3 * u * u * (w.p1[0] - w.p0[0]) +
        6 * u * t * (w.p2[0] - w.p1[0]) +
        3 * t * t * (w.p3[0] - w.p2[0]),
      3 * u * u * (w.p1[1] - w.p0[1]) +
        6 * u * t * (w.p2[1] - w.p1[1]) +
        3 * t * t * (w.p3[1] - w.p2[1]),
    ];
  };
  const halfWidth = (t: number) => {
    const s = t < w.belly ? t / w.belly : (1 - t) / (1 - w.belly);
    return (w.width * Math.pow(Math.max(s, 0), w.ease)) / 2;
  };

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const p = at(t);
    const d = tangent(t);
    const m = Math.hypot(d[0], d[1]) || 1;
    const n: Point = [-d[1] / m, d[0] / m];
    const h = halfWidth(t);
    left.push([p[0] + n[0] * h, p[1] + n[1] * h]);
    right.push([p[0] - n[0] * h, p[1] - n[1] * h]);
  }
  const start = knot(left, 0);
  return (
    `<path d="M ${fixed(start[0])} ${fixed(start[1])}` +
    `${throughPoints(left)}${throughPoints([...right].reverse())} Z" fill="${w.fill}"/>`
  );
}

function markBody(name: string): string {
  const v = VARIANTS[name];
  if (v === undefined) throw new Error(`No such variant: ${name}`);
  const shapes = [...v.whooshes.map(whooshPath), batonPath()].join("");
  return `<g transform="translate(${String(v.dx)} ${String(v.dy)}) scale(${String(v.scale)})">${shapes}</g>`;
}

const indent = (markup: string, pad: string) =>
  markup.replaceAll("><", `>\n${pad}<`).split("\n").join(`\n`).replace(/^/, "");

/**
 * The note carried at the top of `public/app-icon.svg`. It is the mark's
 * rationale, and it lives in the artifact rather than in a document because the
 * SVG is what a later reader opens first.
 */
const RATIONALE = `  <!--
    Baton's app icon, and the source of truth for every drawing of the mark.
    Do not hand-edit: this file, \`public/app-icon.png\`, \`public/favicon.svg\`
    and \`src/components/BatonMark.tsx\` are all written by \`pnpm icon\` from
    \`scripts/icon.ts\`, and the whoosh outlines are sampled curves that cannot
    be meaningfully edited by hand. Change the geometry there and re-run, or the
    app ends up showing two different marks in the same browser tab.

    One baton, thrown, and three whooshes for the air behind it. Nothing touches
    the baton: anything it rests against anchors it and turns it into a part in
    a machine. The motion is never a second copy of the baton either, because a
    ghosted or repeated baton reads as two objects rather than one object
    moving.

    The whooshes are calligraphic, not capsules - each swells to a belly and
    closes to a point at both ends. A round-capped stroke shares the baton's own
    vocabulary and reads as a second, stunted baton; a stroke that tapers reads
    as air. Each carries a different belly, length and arc, because three
    matched strokes read as a rigid grille.

    Solid fills only, no gradient, no text, and square canvas corners, which
    Shopify rounds itself.
    https://shopify.dev/docs/apps/design/visual-design#app-icon
  -->`;

function writeArtifacts(): void {
  const body = indent(markBody(CURRENT), "    ");

  writeFileSync(
    join(ROOT, "public/app-icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
${RATIONALE}
  <rect width="1200" height="1200" fill="${GROUND}"/>
  ${body}
</svg>
`,
  );

  writeFileSync(
    join(ROOT, "public/favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <!-- Written by \`pnpm icon\`. The mark of \`public/app-icon.svg\`, rounded: a favicon is never squared off by its host. -->
  <rect width="1200" height="1200" rx="${String(FAVICON_RADIUS)}" fill="${GROUND}"/>
  ${body}
</svg>
`,
  );

  const jsx = indent(markBody(CURRENT), "      ")
    .replaceAll("stroke-width=", "strokeWidth=")
    .replaceAll("stroke-linecap=", "strokeLinecap=")
    .replaceAll("/>", " />");

  writeFileSync(
    join(ROOT, "src/components/BatonMark.tsx"),
    `/**
 * The Baton mark, drawn once for the whole app.
 *
 * Written by \`pnpm icon\` from \`scripts/icon.ts\`; do not hand-edit, and see
 * \`public/app-icon.svg\` for why the mark is drawn the way it is. This is the
 * source of truth for every copy rendered *inside* the app, so a screen that
 * wants the mark renders this rather than pasting a fifth copy of the paths.
 *
 * It is inlined rather than an \`<img src="/favicon.svg">\` so a screen costs one
 * request fewer and still prints: a printed member work page is a job ticket,
 * and a ticket whose header image was dropped by the print path is harder to
 * identify on a bench.
 *
 * Corners are rounded here, as on the favicon. Only the App Store upload is
 * square, because Shopify rounds that one itself.
 */
export function BatonMark({ size = 24 }: { readonly size?: number }) {
  return (
    <svg
      viewBox="0 0 1200 1200"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect width="1200" height="1200" rx="${String(FAVICON_RADIUS)}" fill="${GROUND}" />
      ${jsx}
    </svg>
  );
}
`,
  );
}

/**
 * Rasterises `public/app-icon.svg` to the 1200x1200 PNG Shopify's Dev Dashboard
 * takes, then re-measures the mark against Shopify's grid and prints the result.
 * The measurement is the point: the scale and offset in {@link VARIANTS} are
 * only correct until someone edits the geometry, and a mark that drifts outside
 * 750-900px or inside the 75px margin is rejected at submission, not here.
 */
function renderPng(): void {
  const chrome = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find((p) => existsSync(p));
  if (chrome === undefined) {
    console.log("! Chrome not found; SVGs written, PNG not re-exported.");
    return;
  }
  const png = join(ROOT, "public/app-icon.png");
  execFileSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      `--screenshot=${png}`,
      "--window-size=1200,1200",
      `file://${join(ROOT, "public/app-icon.svg")}`,
    ],
    // Headless Chrome writes display-link and allocator warnings to stderr on
    // macOS even on a clean run; they are not this script's business.
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    execFileSync("magick", [png, "-strip", "-define", "png:color-type=2", png]);
    const trimmed = execFileSync("magick", [
      png,
      "-bordercolor",
      GROUND,
      "-border",
      "1",
      "-fuzz",
      "1%",
      "-trim",
      "info:-",
    ]).toString();
    const m = /(\d+)x(\d+) \d+x\d+\+(\d+)\+(\d+)/.exec(trimmed);
    if (m) {
      const [w, h, x, y] = m.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
      ];
      const margins = [x - 1, 1200 - (x - 1) - w, y - 1, 1200 - (y - 1) - h];
      const long = Math.max(w, h);
      const tight = Math.min(...margins);
      console.log(
        `  fit: mark ${String(w)} x ${String(h)}, margins ${margins.join("/")} (l/r/t/b)`,
      );
      console.log(
        `  ${long >= 750 && long <= 900 ? "ok" : "OUT OF SPEC"}: long side ${String(long)}px (Shopify wants 750-900)`,
      );
      console.log(
        `  ${tight >= 75 ? "ok" : "OUT OF SPEC"}: tightest margin ${String(tight)}px (Shopify wants >= 75)`,
      );
    }
  } catch {
    console.log("! ImageMagick not found; PNG written but not measured.");
  }
}

/**
 * Runs the repo formatter over the generated component.
 *
 * Without this the generator and `pnpm fmt` disagree about the emitted JSX, so
 * every `pnpm icon` leaves a diff that the next `pnpm fmt` rewrites and the
 * next `pnpm icon` rewrites back, and the repo never converges. Emitting
 * pre-formatted markup by hand would be guessing at the formatter's rules, so
 * the formatter is asked instead.
 */
function formatGenerated(): void {
  try {
    execFileSync(
      "pnpm",
      ["exec", "oxfmt", join(ROOT, "src/components/BatonMark.tsx")],
      {
        cwd: ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    console.log("! oxfmt failed; run `pnpm fmt` before committing.");
  }
}

writeArtifacts();
formatGenerated();
renderPng();
console.log(
  `Wrote the "${CURRENT}" mark to public/ and src/components/BatonMark.tsx`,
);
