// Checks and prints the action matrices in src/lib/Domain.ts (the JSDoc on
// `runActions` and `taskActions`), which the test reads as the spec.
//
//   node scripts/action-table.ts check   parse both tables, refuse overlapping rows, check the glossary (exit 1 on any failure)
//   node scripts/action-table.ts print   render the parsed rows and how many fixtures each expands to

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Result } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { readFileSync } from "node:fs";

import * as ActionTable from "./lib/action-table.ts";

const DOMAIN = new URL("../src/lib/Domain.ts", import.meta.url).pathname;
const NAMES: readonly ActionTable.TableName[] = ["runActions", "taskActions"];

const readSource = Effect.sync(() => readFileSync(DOMAIN, "utf8"));

const checkCommand = Command.make(
  "check",
  {},
  Effect.fn(function* () {
    const source = yield* readSource;
    const failures = [
      ...NAMES.flatMap((name) =>
        Result.match(ActionTable.parse(source, name), {
          onFailure: (error) => [error.message],
          onSuccess: (rows) =>
            ActionTable.overlaps(name, rows).map(
              ([a, b]) =>
                `${name}, lines ${String(a.line)} and ${String(b.line)}: rows share a fixture`,
            ),
        }),
      ),
      ...ActionTable.checkGlossary(source).map(
        (word) =>
          `Glossary: \`${word}\` does not occur in src/lib/Domain.ts outside the glossary`,
      ),
    ];
    for (const failure of failures) yield* Console.error(failure);
    if (failures.length > 0)
      yield* new CliError.UserError({
        cause: "action tables",
        userMessage: `${String(failures.length)} action table failure(s)`,
      });
  }),
).pipe(
  Command.withDescription(
    "Parse the action tables in Domain.ts and check the glossary; exit 1 on any failure",
  ),
);

const printCommand = Command.make(
  "print",
  {},
  Effect.fn(function* () {
    const source = yield* readSource;
    for (const name of NAMES) {
      yield* Console.log(name);
      const lines = Result.match(ActionTable.parse(source, name), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `[${String(ActionTable.expand(name, row, { teamId: "t", blocker: "b" }).length)}] ${ActionTable.renderRow(name, row)}`,
          ),
      });
      for (const line of lines) yield* Console.log(`  ${line}`);
    }
  }),
).pipe(
  Command.withDescription(
    "Render the parsed action tables and their fixture counts",
  ),
);

const actionTableCommand = Command.make("action-table").pipe(
  Command.withDescription("The action matrices in src/lib/Domain.ts"),
  Command.withSubcommands([checkCommand, printCommand]),
);

NodeRuntime.runMain(
  actionTableCommand.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
