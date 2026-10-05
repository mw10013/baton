import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Latest means the greatest UTC folder date and numeric daily sequence, not
 * file modification time. Legacy timestamp folders sort by date and time,
 * before numbered folders on the same date. Skip folders without an MP3.
 * Within a folder containing multiple MP3s, choose the first filename sorted.
 * A sequence selects that daily number on the newest date with a playable
 * match, ignoring legacy timestamp folders. Missing matches never fall back
 * to another sequence.
 */
export async function latestRecording(
  root: string,
  sequence?: number,
): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const numbered = /^(?<day>\d{8})-(?<sequence>\d+)-/u.exec(
        entry.name,
      )?.groups;
      const legacy =
        /^(?<day>\d{4}-\d{2}-\d{2})T(?<time>\d{2}-\d{2}-\d{2}\.\d{3})Z-/u.exec(
          entry.name,
        )?.groups;
      if (
        numbered &&
        (sequence === undefined || Number(numbered.sequence) === sequence)
      )
        return [
          {
            name: entry.name,
            day: Number(numbered.day),
            sequence: Number(numbered.sequence),
            time: 0,
          },
        ];
      if (legacy && sequence === undefined)
        return [
          {
            name: entry.name,
            day: Number(legacy.day.replaceAll("-", "")),
            sequence: 0,
            time: Number(legacy.time.replaceAll(/[-.]/gu, "")),
          },
        ];
      return [];
    })
    .toSorted(
      (a, b) =>
        b.day - a.day ||
        b.sequence - a.sequence ||
        b.time - a.time ||
        b.name.localeCompare(a.name),
    );
  for (const folder of candidates) {
    const files = await readdir(resolve(root, folder.name), {
      withFileTypes: true,
    });
    const audio = files
      .filter((file) => file.isFile() && file.name.endsWith(".mp3"))
      .map((file) => file.name)
      .toSorted()[0];
    if (audio) return resolve(root, folder.name, audio);
  }
  throw new Error("No recording found");
}
