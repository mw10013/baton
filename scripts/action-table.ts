// Checks and prints the action matrices in src/lib/Domain.ts (the JSDoc on
// `runActions` and `taskActions`), which the test reads as the spec, and the
// data-model table on `initializeSchema` in src/lib/ShopAgentSchema.ts.
//
//   node scripts/action-table.ts check   parse both action tables, refuse overlapping rows, check the glossary, its screen columns and its Screens table, parse the data-model table and refuse a pinned title no test carries (exit 1 on any failure)
//   node scripts/action-table.ts print   render the parsed rows and how many fixtures each expands to, then the data-model rows

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Result } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { globSync, readdirSync, readFileSync } from "node:fs";

import * as Domain from "../src/lib/Domain.ts";
import * as ActionTable from "./lib/action-table.ts";

const DOMAIN = new URL("../src/lib/Domain.ts", import.meta.url).pathname;
const ROUTES = new URL("../src/routes/", import.meta.url).pathname;
const SCHEMA = new URL("../src/lib/ShopAgentSchema.ts", import.meta.url)
  .pathname;
const ROOT = new URL("../", import.meta.url).pathname;
const NAMES: readonly ActionTable.TableName[] = ["runActions", "taskActions"];

const SCREEN_LABELS: ActionTable.ScreenLabels = {
  taskStates: Domain.TASK_STATE_LABEL,
  runStates: Domain.RUN_STATE_LABEL,
  workflowStates: Domain.WORKFLOW_STATE_LABEL,
  verbs: Domain.VERB_LABEL,
};

const readSource = Effect.sync(() => readFileSync(DOMAIN, "utf8"));

const readSchemaSource = Effect.sync(() => readFileSync(SCHEMA, "utf8"));

const readTestSources = Effect.sync(() =>
  Object.fromEntries(
    globSync("test/**/*.test.ts", { cwd: ROOT }).map((file) => [
      file,
      readFileSync(`${ROOT}${file}`, "utf8"),
    ]),
  ),
);

const readRouteFiles = Effect.sync(() =>
  Object.fromEntries(
    readdirSync(ROUTES).map((file) => [
      file,
      readFileSync(`${ROUTES}${file}`, "utf8"),
    ]),
  ),
);

const checkCommand = Command.make(
  "check",
  {},
  Effect.fn(function* () {
    const source = yield* readSource;
    const routeFiles = yield* readRouteFiles;
    const schemaSource = yield* readSchemaSource;
    const testSources = yield* readTestSources;
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
      ...ActionTable.checkScreenColumns(source, SCREEN_LABELS),
      ...ActionTable.checkScreens(source, routeFiles),
      ...Result.match(ActionTable.parseDataModel(schemaSource), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) => ActionTable.checkPinned(rows, testSources),
      }),
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
    "Parse the action tables in Domain.ts, check the glossary, and check the data-model table in ShopAgentSchema.ts; exit 1 on any failure",
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
    yield* Console.log("initializeSchema");
    const rows = Result.match(
      ActionTable.parseDataModel(yield* readSchemaSource),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.about}: ${row.rule} [${row.holdsBy}] — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of rows) yield* Console.log(`  ${line}`);
  }),
).pipe(
  Command.withDescription(
    "Render the parsed action tables and their fixture counts",
  ),
);

const actionTableCommand = Command.make("action-table").pipe(
  Command.withDescription(
    "The action matrices in src/lib/Domain.ts and the data-model table in src/lib/ShopAgentSchema.ts",
  ),
  Command.withSubcommands([checkCommand, printCommand]),
);

NodeRuntime.runMain(
  actionTableCommand.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
