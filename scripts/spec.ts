// Checks and prints the spec: the action matrices in src/lib/domain/ShopWork.ts
// (the JSDoc on `runActions` and `taskActions`), which the test reads as the
// spec, the vocabulary (the map in src/lib/Domain.ts and each context file's
// block under src/lib/domain/), the triggers table on `ShopUsage` in
// src/lib/domain/Billing.ts (what each trigger
// does to the usage counts and the usage-event queue), the triggers, actions,
// effects and pass rules tables on `reconcileItem` in
// src/lib/domain/ShopWork.ts (when reconcile runs, what it does to one item,
// what each action does beyond the run, and the rules of a pass), the
// four sync tables on `syncOrder` in src/lib/domain/Orders.ts (what one sync
// does to one order, its sources, the open-orders sync's endings, and its
// rules), the sync pipeline table on `ShopAgentHost` in src/lib/agent/Host.ts, the data-model
// tables on `initializeSchema` in src/lib/ShopAgentSchema.ts (the object) and
// on `D1_TABLES` in src/lib/D1Schema.ts (D1), the three publish tables (the
// cycle table on `InvalidatedMessage` in src/lib/domain/Platform.ts, the
// sites table on `ShopAgent.publish` in src/lib/ShopAgent.ts, and the events
// table on `useLiveQuery` in src/lib/useLiveQuery.ts), and the connection
// table on `ConnectionRole` in src/lib/domain/Platform.ts, the socket's
// authorization rule.
//
//   node scripts/spec.ts check   parse both action tables, refuse overlapping rows, check the vocabulary, its contexts, its screen columns, its stored cells against the DDL and its Screens table, parse the triggers table, the four reconcile tables, the four sync tables on syncOrder (refusing overlapping actions rows), the sync pipeline table, both data-model tables, the three publish tables and the connection table and refuse a pinned title no test carries (in either test project) and a data-model row pinned by (none yet), parse the copy, controls and parts tables in src/lib/Screen.ts and refuse an example no screen shows, a part whose component does not exist and a used-on or Screens template word outside ScreenTemplate (exit 1 on any failure)
//   node scripts/spec.ts print   render the parsed rows and how many fixtures each expands to, then the triggers rows, then the reconcile rows and how many are pinned by (none yet), then the four sync tables, the actions' fixture counts and the count of rows pinned by (none yet), then the sync pipeline rows, then the publish and connection rows, then the data-model rows and how many are pinned by (none yet)

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Result } from "effect";
import { CliError, Command } from "effect/cli";
import { globSync, readdirSync, readFileSync, statSync } from "node:fs";

import * as Domain from "../src/lib/Domain.ts";
import * as Screen from "../src/lib/Screen.ts";
import { copyFiles } from "./lib/copy-files.ts";
import * as ActionTable from "./lib/spec.ts";

const DOMAIN = new URL("../src/lib/Domain.ts", import.meta.url).pathname;
/** The context files under src/lib/domain/, each opening with its own vocabulary. */
const CONTEXTS = ["Platform", "Orders", "Billing", "ShopWork"] as const;
const contextPath = (name: (typeof CONTEXTS)[number]) =>
  new URL(`../src/lib/domain/${name}.ts`, import.meta.url).pathname;
const ROUTES = new URL("../src/routes/", import.meta.url).pathname;
const SCHEMA = new URL("../src/lib/ShopAgentSchema.ts", import.meta.url)
  .pathname;
const D1_SCHEMA = new URL("../src/lib/D1Schema.ts", import.meta.url).pathname;
const SCREEN = new URL("../src/lib/Screen.ts", import.meta.url).pathname;
const HOST = new URL("../src/lib/agent/Host.ts", import.meta.url).pathname;
const readHost = Effect.sync(() => readFileSync(HOST, "utf8"));
const ROOT = new URL("../", import.meta.url).pathname;
const NAMES: readonly ActionTable.TableName[] = ["runActions", "taskActions"];

const SCREEN_LABELS: ActionTable.ScreenLabels = {
  taskStates: Domain.TASK_STATE_LABEL,
  runStates: Domain.RUN_STATE_LABEL,
  workflowStates: Domain.WORKFLOW_STATE_LABEL,
  orderPositions: Domain.ORDER_POSITION_LABEL,
  orderIssues: Domain.ORDER_ISSUE_LABEL,
  workflowFaults: Domain.WORKFLOW_FAULT_LABEL,
  verbs: Domain.VERB_LABEL,
  recordVerbs: Domain.RECORD_VERB_LABEL,
};

/** The barrel's source (the map and the Screens table) and each context file's, by name. */
const readSources = Effect.sync(() => ({
  barrel: readFileSync(DOMAIN, "utf8"),
  contexts: Object.fromEntries(
    CONTEXTS.map((name) => [name, readFileSync(contextPath(name), "utf8")]),
  ) as Record<(typeof CONTEXTS)[number], string>,
}));

/** Each data-model table: its symbol, its source, and the table names its `about` may use. */
const readDataModels = Effect.sync(() => {
  const schemaSource = readFileSync(SCHEMA, "utf8");
  const d1Source = readFileSync(D1_SCHEMA, "utf8");
  return [
    {
      source: schemaSource,
      options: {
        symbol: "initializeSchema",
        tables: ActionTable.tablesDeclared(schemaSource),
      },
    },
    {
      source: d1Source,
      options: {
        symbol: "D1_TABLES",
        tables: ActionTable.tablesNamed(d1Source, [
          "D1_TABLES",
          "BETTER_AUTH_TABLES",
        ]),
      },
    },
  ] as const;
});

const AGENT_CLASS = new URL("../src/lib/ShopAgent.ts", import.meta.url)
  .pathname;
const HOOK = new URL("../src/lib/useLiveQuery.ts", import.meta.url).pathname;

/**
 * The publish tables and the connection table, parsed: the cycle table on
 * `InvalidatedMessage` in Platform, the sites table on `ShopAgent.publish`,
 * the events table on `useLiveQuery`, and the connection table on
 * `ConnectionRole` in Platform. Each is pinned, and `check` and `print`
 * treat them alike.
 */
const readPinnedTables = Effect.sync(() => {
  const platform = readFileSync(contextPath("Platform"), "utf8");
  const agentClass = readFileSync(AGENT_CLASS, "utf8");
  const hook = readFileSync(HOOK, "utf8");
  return [
    {
      title: "InvalidatedMessage cycle",
      parsed: ActionTable.parseInvalidationCycle(platform),
    },
    {
      title: "publish sites",
      parsed: ActionTable.parsePublishSites(agentClass),
    },
    {
      title: "useLiveQuery events",
      parsed: ActionTable.parseClientEvents(hook),
    },
    {
      title: "ConnectionRole connection",
      parsed: ActionTable.parseConnectionEvents(platform),
    },
  ] as const;
});

/**
 * Both projects' test files: the integration project's `.test.ts` and the
 * browser project's `.test.tsx`. Files only: the browser project writes a
 * failed test's screenshots under a directory named for its file.
 */
const readTestSources = Effect.sync(() =>
  Object.fromEntries(
    globSync("test/**/*.test.{ts,tsx}", { cwd: ROOT })
      .filter((file) => statSync(`${ROOT}${file}`).isFile())
      .map((file) => [file, readFileSync(`${ROOT}${file}`, "utf8")]),
  ),
);

const PARTS = new URL("../src/components/screen/", import.meta.url).pathname;

const readScreen = Effect.sync(() => ({
  source: readFileSync(SCREEN, "utf8"),
  partFiles: readdirSync(PARTS),
  screens: Object.fromEntries(
    copyFiles().map((file) => [file, readFileSync(file, "utf8")]),
  ),
}));

const CLIENT = new URL("../src/lib/ShopAgentClient.ts", import.meta.url)
  .pathname;

/** The sources the Shape families table is checked against: the context files, `ShopAgentClient.ts` and the routes, by path. */
const shapeSources = (
  contexts: Readonly<Record<string, string>>,
  routeFiles: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(
    Object.entries(contexts).map(([name, source]) => [
      `src/lib/domain/${name}.ts`,
      source,
    ]),
  ),
  "src/lib/ShopAgentClient.ts": readFileSync(CLIENT, "utf8"),
  ...Object.fromEntries(
    Object.entries(routeFiles).map(([file, source]) => [
      `src/routes/${file}`,
      source,
    ]),
  ),
});

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
    const { barrel, contexts } = yield* readSources;
    const routeFiles = yield* readRouteFiles;
    const dataModels = yield* readDataModels;
    const testSources = yield* readTestSources;
    const screen = yield* readScreen;
    const host = yield* readHost;
    const contextSources = Object.values(contexts);
    const failures = [
      ...NAMES.flatMap((name) =>
        Result.match(ActionTable.parse(contexts.ShopWork, name), {
          onFailure: (error) => [error.message],
          onSuccess: (rows) => [
            ...ActionTable.overlaps(name, rows).map(
              ([a, b]) =>
                `${name}, lines ${String(a.line)} and ${String(b.line)}: rows share a fixture`,
            ),
            ...ActionTable.gaps(name, rows).map(
              (fixture) => `${name}: no row covers ${JSON.stringify(fixture)}`,
            ),
          ],
        }),
      ),
      ...[
        { file: "Domain.ts", source: barrel, others: contextSources },
        ...CONTEXTS.map((name) => ({
          file: `domain/${name}.ts`,
          source: contexts[name],
          others: [barrel],
        })),
      ].flatMap(({ file, source, others }) =>
        ActionTable.checkVocabulary(source, others, contexts).map(
          (word) =>
            `Vocabulary: \`${word}\` does not occur in src/lib/${file} outside the vocabulary`,
        ),
      ),
      ...ActionTable.checkScreenColumns(contexts.ShopWork, SCREEN_LABELS),
      ...ActionTable.checkStoredCells(contexts.ShopWork, dataModels[0].source),
      ...ActionTable.checkContexts(barrel, contextSources),
      ...ActionTable.checkOrderIssues(
        contexts.ShopWork,
        Domain.OrderIssue.literals,
      ),
      ...ActionTable.checkScreens(
        barrel,
        routeFiles,
        Screen.ScreenTemplate.literals,
      ),
      ...ActionTable.checkShapeFamilies(
        barrel,
        shapeSources(contexts, routeFiles),
      ),
      ...Result.match(ActionTable.parseTriggerTable(contexts.Billing), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          ActionTable.checkPinned(rows, testSources, "ShopUsage"),
      }),
      ...Result.match(ActionTable.parseReconcileTriggers(contexts.ShopWork), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          ActionTable.checkPinned(rows, testSources, "reconcileItem"),
      }),
      ...Result.match(ActionTable.parseReconcileActions(contexts.ShopWork), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) => [
          ...ActionTable.reconcileActionOverlaps(rows).map(
            ([a, b]) =>
              `reconcileItem actions, lines ${String(a.line)} and ${String(b.line)}: rows share a fixture`,
          ),
          ...ActionTable.reconcileActionGaps(rows).map(
            (fixture) =>
              `reconcileItem actions: no row covers ${JSON.stringify(fixture)}`,
          ),
        ],
      }),
      ...Result.match(ActionTable.parseSyncActions(contexts.Orders), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          ActionTable.syncActionOverlaps(rows).map(
            ([a, b]) =>
              `syncOrder actions, lines ${String(a.line)} and ${String(b.line)}: rows share a fixture`,
          ),
      }),
      ...[
        ActionTable.parseSyncSources(contexts.Orders),
        ActionTable.parseSyncEndings(contexts.Orders),
        ActionTable.parseSyncRules(contexts.Orders),
      ].flatMap((parsed) =>
        Result.match(parsed, {
          onFailure: (error) => [error.message],
          onSuccess: (rows: readonly { line: number; pinnedBy: string }[]) =>
            ActionTable.checkPinned(rows, testSources, "syncOrder"),
        }),
      ),
      ...Result.match(ActionTable.parseReconcileEffects(contexts.ShopWork), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          ActionTable.checkPinned(rows, testSources, "reconcileItem"),
      }),
      ...Result.match(ActionTable.parseReconcilePassRules(contexts.ShopWork), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          ActionTable.checkPinned(rows, testSources, "reconcileItem"),
      }),
      ...Result.match(ActionTable.parseSyncPipeline(host), {
        onFailure: (error) => [error.message],
        onSuccess: () => [],
      }),
      ...(yield* readPinnedTables).flatMap(({ title, parsed }) =>
        Result.match(parsed, {
          onFailure: (error) => [error.message],
          onSuccess: (rows) =>
            ActionTable.checkPinned(rows, testSources, title),
        }),
      ),
      ...dataModels.flatMap(({ source, options }) =>
        Result.match(ActionTable.parseDataModel(source, options), {
          onFailure: (error) => [error.message],
          onSuccess: (rows) => [
            ...ActionTable.checkPinned(rows, testSources, options.symbol),
            ...ActionTable.checkDataModelUnpinned(rows, options.symbol),
          ],
        }),
      ),
      ...Result.match(
        ActionTable.parseCopyTable(screen.source, Screen.CopySlot.literals),
        {
          onFailure: (error) => [error.message],
          onSuccess: (rows) =>
            ActionTable.checkCopyExamples(rows, screen.screens),
        },
      ),
      ...Result.match(ActionTable.parseControls(screen.source), {
        onFailure: (error) => [error.message],
        onSuccess: () => [],
      }),
      ...Result.match(
        ActionTable.parsePartsTable(
          screen.source,
          Screen.ScreenPart.literals,
          Screen.ScreenTemplate.literals,
          screen.partFiles,
        ),
        {
          onFailure: (error) => [error.message],
          onSuccess: () => [],
        },
      ),
    ];
    for (const failure of failures) yield* Console.error(failure);
    if (failures.length > 0)
      yield* new CliError.UserError({
        cause: "spec",
        userMessage: `${String(failures.length)} spec failure(s)`,
      });
  }),
).pipe(
  Command.withDescription(
    "Parse the action tables and the four reconcile tables (triggers, actions, effects, pass rules) in domain/ShopWork.ts, the four sync tables on syncOrder in domain/Orders.ts, the sync pipeline table in agent/Host.ts and the three publish tables (InvalidatedMessage in domain/Platform.ts, publish in ShopAgent.ts, useLiveQuery) and the connection table (ConnectionRole in domain/Platform.ts), check the vocabulary in Domain.ts and domain/ and its stored cells against the DDL in ShopAgentSchema.ts, check the triggers table on ShopUsage in domain/Billing.ts and the data-model tables in ShopAgentSchema.ts and D1Schema.ts (none pinned by (none yet)), check the copy, controls and parts tables in Screen.ts (each part's component exists, its used-on cell names only template words) and the Screens table's template column; exit 1 on any failure",
  ),
);

const printCommand = Command.make(
  "print",
  {},
  Effect.fn(function* () {
    const { barrel, contexts } = yield* readSources;
    yield* Console.log("Shape families");
    const families =
      ActionTable.vocabularyTables(barrel).find((each) =>
        each.intro.startsWith("Shape families."),
      )?.rows ?? [];
    for (const row of families)
      yield* Console.log(
        `  ${row.family ?? ""}: ${row.suffix ?? ""} in ${row["lives in"] ?? ""}, rule on ${row["rule on"] ?? ""}`,
      );
    for (const name of NAMES) {
      yield* Console.log(name);
      const lines = Result.match(ActionTable.parse(contexts.ShopWork, name), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `[${String(ActionTable.expand(name, row, { teamId: "t" }).length)}] ${ActionTable.renderRow(name, row)}`,
          ),
      });
      for (const line of lines) yield* Console.log(`  ${line}`);
    }
    yield* Console.log("ShopUsage");
    const triggers = Result.match(
      ActionTable.parseTriggerTable(contexts.Billing),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.trigger}: orders ${row.orderCount}, seats ${row.seatMark}, queue ${row.queue} — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of triggers) yield* Console.log(`  ${line}`);
    yield* Console.log("reconcileItem triggers");
    const reconcileTriggers = Result.match(
      ActionTable.parseReconcileTriggers(contexts.ShopWork),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.trigger}: ${row.shape}, skipped when ${row.skippedWhen} — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of reconcileTriggers) yield* Console.log(`  ${line}`);
    yield* Console.log("reconcileItem actions");
    const actions = Result.match(
      ActionTable.parseReconcileActions(contexts.ShopWork),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `[${String(ActionTable.expandReconcileAction(row).length)}] ${row.text}`,
          ),
      },
    );
    for (const line of actions) yield* Console.log(`  ${line}`);
    yield* Console.log("reconcileItem effects");
    const effects = Result.match(
      ActionTable.parseReconcileEffects(contexts.ShopWork),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.action}: run row ${row.runRow}, counted order ${row.countedOrder}, queue ${row.queue} — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of effects) yield* Console.log(`  ${line}`);
    yield* Console.log("reconcileItem pass rules");
    const passRules = Result.match(
      ActionTable.parseReconcilePassRules(contexts.ShopWork),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) => `${row.rule} [${row.where.join(", ")}] — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of passRules) yield* Console.log(`  ${line}`);
    const unpinned = [
      ActionTable.parseReconcileTriggers(contexts.ShopWork),
      ActionTable.parseReconcileEffects(contexts.ShopWork),
      ActionTable.parseReconcilePassRules(contexts.ShopWork),
    ].reduce(
      (total, parsed) =>
        total +
        Result.match(parsed, {
          onFailure: () => 0,
          onSuccess: (rows: readonly { readonly pinnedBy: string }[]) =>
            rows.filter((row) => row.pinnedBy === ActionTable.NONE_YET).length,
        }),
      0,
    );
    yield* Console.log(
      `reconcileItem: ${String(unpinned)} rows pinned by ${ActionTable.NONE_YET}`,
    );
    yield* Console.log("syncOrder actions");
    const syncActions = Result.match(
      ActionTable.parseSyncActions(contexts.Orders),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `[${String(ActionTable.expandSyncAction(row).length)}] ${row.text}`,
          ),
      },
    );
    for (const line of syncActions) yield* Console.log(`  ${line}`);
    yield* Console.log("syncOrder sources");
    const syncSources = Result.match(
      ActionTable.parseSyncSources(contexts.Orders),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.source}: ${row.who}; skipped when ${row.skippedWhen} — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of syncSources) yield* Console.log(`  ${line}`);
    yield* Console.log("syncOrder endings");
    const syncEndings = Result.match(
      ActionTable.parseSyncEndings(contexts.Orders),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.ending}: tracking row ${row.trackingRow}, lastError ${row.lastError} — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of syncEndings) yield* Console.log(`  ${line}`);
    yield* Console.log("syncOrder rules");
    const syncRules = Result.match(
      ActionTable.parseSyncRules(contexts.Orders),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) => `${row.rule} [${row.where.join(", ")}] — ${row.pinnedBy}`,
          ),
      },
    );
    for (const line of syncRules) yield* Console.log(`  ${line}`);
    const syncUnpinned = [
      ActionTable.parseSyncSources(contexts.Orders),
      ActionTable.parseSyncEndings(contexts.Orders),
      ActionTable.parseSyncRules(contexts.Orders),
    ].reduce(
      (total, parsed) =>
        total +
        Result.match(parsed, {
          onFailure: () => 0,
          onSuccess: (rows: readonly { readonly pinnedBy: string }[]) =>
            rows.filter((row) => row.pinnedBy === ActionTable.NONE_YET).length,
        }),
      0,
    );
    yield* Console.log(
      `syncOrder: ${String(syncUnpinned)} rows pinned by ${ActionTable.NONE_YET}`,
    );
    yield* Console.log("ShopAgentHost sync pipeline");
    const pipeline = Result.match(
      ActionTable.parseSyncPipeline(yield* readHost),
      {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${row.source}: store ${row.store}; reconcile ${row.reconcile}; flush ${row.flush}`,
          ),
      },
    );
    for (const line of pipeline) yield* Console.log(`  ${line}`);
    for (const { title, parsed } of yield* readPinnedTables) {
      yield* Console.log(title);
      const lines = Result.match(parsed, {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `${Object.values(row.cells).join(" | ")} — ${row.pinnedBy}`,
          ),
      });
      for (const line of lines) yield* Console.log(`  ${line}`);
    }
    for (const { source: dataModel, options } of yield* readDataModels) {
      yield* Console.log(options.symbol);
      const rows = Result.match(
        ActionTable.parseDataModel(dataModel, options),
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
      const unpinned = Result.match(
        ActionTable.parseDataModel(dataModel, options),
        {
          onFailure: () => 0,
          onSuccess: (rows) =>
            rows.filter((row) =>
              row.pinnedBy.split("; ").includes(ActionTable.NONE_YET),
            ).length,
        },
      );
      yield* Console.log(
        `${options.symbol}: ${String(unpinned)} rows pinned by ${ActionTable.NONE_YET}, at most ${String(ActionTable.DATA_MODEL_NONE_YET_MAX)}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Render the parsed action tables and their fixture counts, then the triggers rows, then the reconcile rows, the actions' fixture counts and the count of rows pinned by (none yet), then the four sync tables, the actions' fixture counts and the count of rows pinned by (none yet), then the sync pipeline rows, then the publish and connection rows, then the data-model rows and how many are pinned by (none yet)",
  ),
);

const specCommand = Command.make("spec").pipe(
  Command.withDescription(
    "The action matrices in src/lib/domain/ShopWork.ts, the vocabulary in src/lib/Domain.ts and src/lib/domain/, the triggers table in src/lib/domain/Billing.ts, the data-model tables in src/lib/ShopAgentSchema.ts and src/lib/D1Schema.ts, and the publish tables and the connection table",
  ),
  Command.withSubcommands([checkCommand, printCommand]),
);

NodeRuntime.runMain(
  specCommand.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
