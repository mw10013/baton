#!/usr/bin/env node
/**
 * `vp run probe:rows-read:report [runs]`: the newest `runs` (default 3) runs of the rows-read
 * probe (`vp run probe:rows-read`), from `.logs/probe/rows-read/`, as one markdown table: each
 * path's median rows read, written and returned per database, and the spread across the runs.
 */
import { readdirSync, readFileSync } from "node:fs";

interface Counts {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsReturned: number;
}
interface Measurement {
  readonly path: string;
  readonly actor: Counts;
  readonly d1: Counts;
}

const dir = ".logs/probe/rows-read";
const count = Number(process.argv[2] ?? 3);
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .toSorted()
  .slice(-count);
const runs = files.map((file): ReadonlyArray<Measurement> =>
  JSON.parse(readFileSync(`${dir}/${file}`, "utf8")),
);

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
/** The median, and the range when the runs disagree. */
const cell = (values: ReadonlyArray<number>) => {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? String(low) : `${String(median(values))} (${String(low)}–${String(high)})`;
};

const paths = runs[0]?.map(({ path }) => path) ?? [];
const column = (path: string, pick: (m: Measurement) => number) =>
  cell(runs.flatMap((run) => run.filter((m) => m.path === path).map(pick)));
const row = (cells: ReadonlyArray<string>) => `| ${cells.join(" | ")} |`;

console.log(`Runs: ${String(runs.length)} (${files.join(", ")})\n`);
console.log(
  row([
    "path",
    "actor read",
    "actor written",
    "actor returned",
    "D1 read",
    "D1 written",
    "D1 returned",
  ]),
);
console.log(row(["---", "---:", "---:", "---:", "---:", "---:", "---:"]));
for (const path of paths)
  console.log(
    row([
      path,
      column(path, (m) => m.actor.rowsRead),
      column(path, (m) => m.actor.rowsWritten),
      column(path, (m) => m.actor.rowsReturned),
      column(path, (m) => m.d1.rowsRead),
      column(path, (m) => m.d1.rowsWritten),
      column(path, (m) => m.d1.rowsReturned),
    ]),
  );
