import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Runs a command to completion and returns its stdout. A non-zero exit fails
 * with the command line and its stderr in the message; `spawner.string` does
 * not check the exit code, which is why this exists.
 */
export const runCommand = (
  command: string,
  args: readonly string[],
  input?: string,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        command,
        [...args],
        input === undefined
          ? undefined
          : { stdin: Stream.make(new TextEncoder().encode(input)) },
      ),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: "unbounded" },
    );
    const exitCode = yield* handle.exitCode;
    return exitCode === ChildProcessSpawner.ExitCode(0)
      ? stdout
      : yield* new CommandError({
          message: `${command} ${args.join(" ")} exited ${String(exitCode)}${stderr ? `: ${stderr}` : ""}`,
        });
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause instanceof CommandError
        ? cause
        : new CommandError({
            message: `Failed to run ${command} ${args.join(" ")}`,
            cause,
          }),
    ),
  );
