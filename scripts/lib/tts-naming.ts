import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Recording excerpts preserve Unicode letters and numbers, remove apostrophes,
 * and turn other punctuation into word separators. Limit to 80 code points at
 * a word boundary; truncate a single oversized word. Empty excerpts use speech.
 */
export function speechExcerpt(text: string): string {
  const slug = text
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/['’]/gu, "")
    .replaceAll(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  // eslint-disable-next-line typescript/no-misused-spread -- String iteration counts Unicode code points.
  const points = [...slug];
  if (points.length <= 80) return slug || "speech";
  const prefix = points.slice(0, 80).join("");
  if (points[80] === "-") return prefix;
  const boundary = prefix.lastIndexOf("-");
  return boundary > 0 ? prefix.slice(0, boundary) : prefix;
}

/**
 * UTC dates group recordings. Daily numbers advance past the highest existing
 * folder number, not the folder count. Reserve with exclusive mkdir before a
 * paid request; concurrent reservations rescan after a collision. Dry previews
 * neither create folders nor consume numbers. Numbers use at least two digits;
 * beyond 99 they remain unique but no longer sort numerically as plain text.
 */
export async function recordingOutput(
  root: string,
  text: string,
  reserve: boolean,
  date = new Date(),
): Promise<string> {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const excerpt = speechExcerpt(text);
  if (reserve) await mkdir(root, { recursive: true });
  while (true) {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      },
    );
    const highest = entries.reduce((maximum, entry) => {
      const match = entry.isDirectory()
        ? new RegExp(`^${day}-(\\d+)-`, "u").exec(entry.name)
        : null;
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0);
    const folder = resolve(
      root,
      `${day}-${String(highest + 1).padStart(2, "0")}-${excerpt}`,
    );
    if (!reserve) return resolve(folder, `${excerpt}.mp3`);
    try {
      await mkdir(folder);
      return resolve(folder, `${excerpt}.mp3`);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
  }
}
