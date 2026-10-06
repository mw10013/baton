import { describe, expect, it } from "vitest";

import barrel from "@/lib/Domain.ts?raw";

import * as RulesLint from "../../scripts/lib/rules-lint.ts";

/**
 * `scripts/lib/rules-lint.ts` on inline sources. Pure, so it runs in the
 * workers pool like `spec.test.ts`.
 */

const hits = (source: string, tsx = true) =>
  RulesLint.retiredCopyHits(source, tsx).map(({ line }) => line);

const matches = (line: string) =>
  RulesLint.INLINE_COMPARISONS.some((pattern) => pattern.test(line));

describe("a state, status, flag or admin role comparison is a Domain predicate", () => {
  it("refuses an inline run state comparison", () => {
    expect(matches('if (run.state === "open") return;')).toBe(true);
    expect(matches('if (run.state !== "done") return;')).toBe(true);
  });

  it("refuses status, flag and admin role comparisons, and passes a predicate", () => {
    expect(matches('order.status === "COMPLETED"')).toBe(true);
    expect(matches('task.flag !== "x"')).toBe(true);
    expect(matches('user.role === "admin"')).toBe(true);
    expect(matches("Domain.runIsOpen(run)")).toBe(false);
  });
});

describe("a retired word stays off every merchant and member screen", () => {
  it("reads string literals, a sentence ending in run., and the literals inside a template's interpolation", () => {
    const source = [
      'const a = "Cancel run";',
      "const b = `No runs.`;",
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      'const c = `Started ${n} ${n === 1 ? "run" : "runs"} on orders.`;',
      'const d = "That line item is done.";',
      'const e = "Every task is finished.";',
      'const f = "mark done";',
      'const g = "Nothing unclaimed.";',
      'const h = "In progress";',
    ].join("\n");
    expect(hits(source, false)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("Edit <noun>s is refused in screen copy", () => {
    const source = [
      "<s-button>Edit teams</s-button>",
      'const a = "Edit members";',
      'const b = "Edit workflows";',
      'const c = "Edit note";',
      "<s-button>Edit</s-button>",
    ].join("\n");
    expect(hits(source)).toEqual([1, 2, 3]);
  });

  it("a Remove heading that asks is refused", () => {
    const source = [
      'const a = "Remove member?";',
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      "const b = `Remove ${email}?`;",
      'const c = "Remove";',
      'const d = "Couldn\'t remove from the team.";',
    ].join("\n");
    expect(hits(source, false)).toEqual([1, 2]);
  });

  it("reads JSX text on one line, beside an expression, and across lines", () => {
    const source = [
      "<s-text>Cancel run</s-text>",
      "<s-paragraph>Every run is closed.{' '}</s-paragraph>",
      "<s-paragraph>",
      "  {count} runs are open, and",
      "  none of them is run.",
      "</s-paragraph>",
    ].join("\n");
    expect(hits(source)).toEqual([1, 2, 4, 5]);
  });

  it("reads a JSX text line with an ellipsis, parentheses or a percent sign", () => {
    const source = [
      "<s-paragraph>",
      "  Importing… this page updates as orders arrive.",
      "  Finished (and run) today.",
      "  Half of them, 50%, are run.",
      "</s-paragraph>",
      'import { Schema } from "effect";',
    ].join("\n");
    expect(hits(source)).toEqual([2, 3, 4]);
  });

  it("skips comments, identifiers, paths and query keys", () => {
    const source = [
      "// Cancel run",
      "/* the run",
      " * is done */",
      "{/* Every run */}",
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      'const key = ["shop-runs", run.state, "run-actions-1", `${run}`];',
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      "<s-link href={`/work/${runId}`}>",
      "const run = runs.find(isRun);",
    ].join("\n");
    expect(hits(source)).toEqual([]);
  });

  it("staff is a retired word in screen copy", () => {
    const source = [
      'const a = "Unstaffed";',
      "<s-paragraph>",
      "  Add a member to staff the team.",
      "</s-paragraph>",
      "// Shopify staff inside the embedded admin",
    ].join("\n");
    expect(hits(source)).toEqual([1, 3]);
  });

  it("import and resync are retired words in screen copy", () => {
    const source = [
      'const a = "Couldn\'t start the import.";',
      "<s-button>Resync from Shopify</s-button>",
      "<s-paragraph>",
      "  Importing orders from Shopify.",
      "</s-paragraph>",
      'import { Schema } from "effect";',
      "// a re-sync never queues a second count",
    ].join("\n");
    expect(hits(source)).toEqual([1, 2, 4]);
  });

  it("attention is a retired word in screen copy", () => {
    const source = [
      '<s-banner heading="Needs attention" />',
      "<s-paragraph>",
      "  Nothing else needs your attention.",
      "</s-paragraph>",
      "// the derived attention state",
    ].join("\n");
    expect(hits(source)).toEqual([1, 3]);
  });

  it("billing period is a retired word in screen copy", () => {
    const source = [
      "<s-heading>Orders this billing period</s-heading>",
      'const a = "Orders this billing cycle";',
      "// the billing period Shopify reports",
    ].join("\n");
    expect(hits(source)).toEqual([1]);
  });

  it("view is a retired word in screen copy", () => {
    const source = [
      "<s-button>Issues view</s-button>",
      'const a = "Choose a filter";',
      "// the old view row",
      '<svg viewBox="0 0 10 10" />',
      "<s-link href={url}>View in Shopify</s-link>",
    ].join("\n");
    expect(hits(source)).toEqual([1]);
  });

  it("needs a workflow is retired in screen copy", () => {
    const source = [
      '<s-badge tone="critical">Needs a workflow</s-badge>',
      'const a = "Multiple workflows match";',
      "// the old Needs a workflow badge",
    ].join("\n");
    expect(hits(source)).toEqual([1]);
  });

  it("picker is retired in screen copy", () => {
    const source = [
      '<s-select label="Workflow picker" />',
      'const a = "Choose a workflow from the picker";',
      "// the Workflow select at rest",
      'const b = "Workflow";',
    ].join("\n");
    expect(hits(source)).toEqual([1, 2]);
  });

  it("please, successfully, oops, sorry, click here and are you sure are retired in every slot", () => {
    const source = [
      'const a = "Please choose a team.";',
      'const b = "Note saved successfully";',
      "<s-paragraph>",
      "  Oops, that did not work. Sorry.",
      "</s-paragraph>",
      '<s-link href="/app/teams">click here</s-link>',
      'const c = "Note saved";',
      'const d = "Are you sure you want to discard these changes?";',
    ].join("\n");
    expect(hits(source)).toEqual([1, 2, 4, 6, 8]);
  });

  it("names the line and its text", () => {
    expect(
      RulesLint.retiredCopyHits('x;\nconst t = "Keep run";', false),
    ).toEqual([{ line: 2, text: 'const t = "Keep run";' }]);
  });
});

describe("an s-text-area has a label and no placeholder", () => {
  it("reads the opening tag across lines and leaves s-text-field alone", () => {
    const source = [
      "<s-text-area",
      '  label="Reason"',
      '  placeholder="What is stopping this?"',
      "/>",
      '<s-text-field label="Name" placeholder="e.g. Engrave" />',
      '<s-text-area label="Note" rows={6} />',
    ].join("\n");
    expect(RulesLint.textAreaPlaceholderHits(source)).toEqual([
      { line: 1, text: "<s-text-area" },
    ]);
  });
});

describe("an info banner is refused on a merchant or member screen", () => {
  it("reads the opening tag across lines and passes warning and critical", () => {
    const source = [
      "<s-banner",
      '  tone="info"',
      '  heading="Closed"',
      ">",
      '<s-banner tone="warning">{text}</s-banner>',
      '<s-banner tone="critical">{text}</s-banner>',
    ].join("\n");
    expect(RulesLint.infoBannerHits(source)).toEqual([
      { line: 1, text: "<s-banner" },
    ]);
  });
});

describe("maxLength is refused on a field outside src/components/screen/", () => {
  it("reads text, text-area and email fields and leaves a select alone", () => {
    const source = [
      '<s-text-field label="Name" maxLength={64} />',
      "<s-text-area",
      '  label="Instructions"',
      "  maxLength={500}",
      "/>",
      '<s-email-field label="Email" maxLength={254} />',
      '<s-text-field label="Name" />',
      '<s-select label="Team" maxLength={3} />',
    ].join("\n");
    expect(RulesLint.maxLengthHits(source).map(({ line }) => line)).toEqual([
      1, 2, 6,
    ]);
  });
});

describe("an s-option carries no parenthesis", () => {
  it("reads the option's text on the opening line or the next, and passes a name", () => {
    const source = [
      "<s-option value={team.id}>",
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      "  {team.memberCount === 0 ? `${team.name} (no members)` : team.name}",
      "</s-option>",
      '<s-option value="a">A Team (empty)</s-option>',
      '<s-option value="b">B Team</s-option>',
      "<s-option value={team.id}>{team.name}</s-option>",
    ].join("\n");
    expect(
      RulesLint.optionAnnotationHits(source).map(({ line }) => line),
    ).toEqual([1, 4]);
  });
});

describe("a details slot is refused outside src/components/screen/", () => {
  it("refuses a note under a choice and passes a choice that is a name", () => {
    const source = [
      "<s-choice value={team.id}>",
      "  {team.name}",
      '  <s-text slot="details">No members</s-text>',
      "</s-choice>",
      "<s-choice value={member.id}>{member.email}</s-choice>",
    ].join("\n");
    expect(RulesLint.detailsSlotHits(source).map(({ line }) => line)).toEqual([
      3,
    ]);
  });
});

describe("Saved, Saving and Syncing are retired as a sentence's start in screen copy", () => {
  it("refuses a status sentence and passes Note saved and stopped syncing", () => {
    const source = [
      'const a = "Saving…";',
      'const b = "\u2713 Saved · Last changed on ";',
      'const c = "Syncing… this page updates as orders arrive.";',
      'const d = "Note saved";',
      'const e = "Instructions saved";',
      'const f = "New orders stopped syncing at 2,500 open orders.";',
    ].join("\n");
    expect(hits(source, false)).toEqual([1, 2, 3]);
  });
});

describe("an exported identifier carries no reserved stem", () => {
  it("refuses a stem anywhere in an exported name, in any case, and leaves locals and the allowed names alone", () => {
    const source = [
      "export const isTier = () => true;",
      "export type TeamRoster = { id: string };",
      "export const RunTier = 1;",
      "const rosterAtCeiling = 1;",
      "export const CopySlot = 1;",
      "export const workflowIsActive = () => true;",
    ].join("\n");
    expect(RulesLint.reservedStemHits(source)).toEqual([
      { name: "isTier", line: 1, kind: "const" },
      { name: "TeamRoster", line: 2, kind: "type" },
      { name: "RunTier", line: 3, kind: "const" },
    ]);
  });
  it("an export named workflowPicker is refused", () => {
    expect(
      RulesLint.reservedStemHits("export const workflowPicker = () => null;"),
    ).toEqual([{ name: "workflowPicker", line: 1, kind: "const" }]);
  });
  it("an export named ProductionAgent is refused", () => {
    expect(
      RulesLint.reservedStemHits("export class ProductionAgent {}"),
    ).toEqual([{ name: "ProductionAgent", line: 1, kind: "class" }]);
  });
  it("an export named ORDER_IMPORT_WINDOW_DAYS is refused", () => {
    expect(
      RulesLint.reservedStemHits("export const ORDER_IMPORT_WINDOW_DAYS = 30;"),
    ).toEqual([{ name: "ORDER_IMPORT_WINDOW_DAYS", line: 1, kind: "const" }]);
  });
  it("an export named ResyncOrderInput is refused", () => {
    expect(
      RulesLint.reservedStemHits("export const ResyncOrderInput = 1;"),
    ).toEqual([{ name: "ResyncOrderInput", line: 1, kind: "const" }]);
  });
  it("an export named ambiguousItems is refused", () => {
    expect(
      RulesLint.reservedStemHits("export const ambiguousItems = 1;"),
    ).toEqual([{ name: "ambiguousItems", line: 1, kind: "const" }]);
  });
  it("an export named setWorkflowActivatedAt is refused", () => {
    expect(
      RulesLint.reservedStemHits("export const setWorkflowActivatedAt = 1;"),
    ).toEqual([{ name: "setWorkflowActivatedAt", line: 1, kind: "const" }]);
  });
  it("an export named useSubscribedQuery is refused", () => {
    expect(
      RulesLint.reservedStemHits("export const useSubscribedQuery = 1;"),
    ).toEqual([{ name: "useSubscribedQuery", line: 1, kind: "const" }]);
  });
  it("an export named PublishScope is refused", () => {
    expect(RulesLint.reservedStemHits("export type PublishScope = 1;")).toEqual(
      [{ name: "PublishScope", line: 1, kind: "type" }],
    );
  });
});

describe("a state predicate names its noun before the state", () => {
  it("refuses an exported is<State> function or const and leaves <noun>Is<State>, types and locals alone", () => {
    const source = [
      "export const isCancelled = () => true;",
      "export function isValid() { return true; }",
      "export const orderIsCancelled = () => true;",
      "export type IsOpen = boolean;",
      "const isOpen = () => true;",
      "export const issues = [];",
    ].join("\n");
    expect(
      RulesLint.bareStatePredicateHits(source).map(({ name }) => name),
    ).toEqual(["isCancelled", "isValid"]);
  });
});

describe("an import follows the map's direction", () => {
  const map = RulesLint.contextImports(barrel);
  const importHits = (file: string, source: string) =>
    RulesLint.contextImportHits(file, source, map);

  it("the map in Domain.ts reads as each context file's allowed imports", () => {
    expect(Object.fromEntries(map)).toEqual({
      ShopWork: ["Orders", "Platform"],
      Orders: ["Platform"],
      Billing: ["Orders", "Platform"],
      Platform: [],
    });
  });

  it("a context file importing a module under src/ outside lib/domain/ is refused", () => {
    expect(
      importHits(
        "lib/domain/ShopWork.ts",
        [
          'import { Schema } from "effect";',
          'import { layoutIsValid } from "../WorkflowLayout.ts";',
          'import { Screen } from "@/lib/Screen";',
          'import { OrderState } from "./Orders.ts";',
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 2,
        specifier: "../WorkflowLayout.ts",
        allowed: ["Orders", "Platform"],
      },
      { line: 3, specifier: "@/lib/Screen", allowed: ["Orders", "Platform"] },
    ]);
  });

  it("Orders importing ShopWork is refused", () => {
    expect(
      importHits(
        "lib/domain/Orders.ts",
        [
          'import { Schema } from "effect";',
          "",
          'import { WorkflowId } from "./Platform.ts";',
          "import {",
          "  RunState,",
          '} from "./ShopWork.ts";',
        ].join("\n"),
      ),
    ).toEqual([{ line: 4, specifier: "./ShopWork.ts", allowed: ["Platform"] }]);
  });

  it("ShopWork importing Orders is allowed", () => {
    expect(
      importHits(
        "lib/domain/ShopWork.ts",
        [
          'import { orderIsOpen } from "./Orders.ts";',
          'import { Shop } from "./Platform.ts";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("Platform importing anything under domain/ is refused", () => {
    expect(
      importHits(
        "lib/domain/Platform.ts",
        [
          'import { Plan } from "./Billing.ts";',
          'export { ShopOrder } from "./Orders.ts";',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, specifier: "./Billing.ts", allowed: [] },
      { line: 2, specifier: "./Orders.ts", allowed: [] },
    ]);
  });

  it("a route importing @/lib/domain/ShopWork is refused", () => {
    expect(
      importHits(
        "routes/app.index.tsx",
        [
          'import * as Domain from "@/lib/Domain";',
          'import { runActions } from "@/lib/domain/ShopWork";',
          'import { Shop } from "../lib/domain/Platform.ts";',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 2, specifier: "@/lib/domain/ShopWork" },
      { line: 3, specifier: "../lib/domain/Platform.ts" },
    ]);
  });

  it("the barrel re-exports the context files", () => {
    expect(importHits("lib/Domain.ts", barrel)).toEqual([]);
  });
});

const loaderDataNames = (file: string, source: string) =>
  RulesLint.loaderDataExportHits(file, source).map(({ name }) => name);

describe("loader data lives in its route", () => {
  it("a LoaderData export under lib/ is refused", () => {
    expect(
      loaderDataNames(
        "lib/domain/ShopWork.ts",
        "export interface TeamLoaderData {\n  readonly id: string;\n}",
      ),
    ).toEqual(["TeamLoaderData"]);
  });

  it("the same name under routes/ is allowed", () => {
    expect(
      loaderDataNames(
        "routes/app.teams.$teamId.tsx",
        "export interface TeamLoaderData {\n  readonly id: string;\n}",
      ),
    ).toEqual([]);
  });

  it("a local type is ignored", () => {
    expect(
      loaderDataNames(
        "lib/domain/ShopWork.ts",
        "interface TeamLoaderData {\n  readonly id: string;\n}",
      ),
    ).toEqual([]);
  });
});

describe("an import follows the object map's direction", () => {
  it("Orders importing ShopWork is refused", () => {
    expect(
      RulesLint.objectImportHits(
        "lib/agent/Orders.ts",
        'import { ShopAgentHost } from "./Host.ts";\nimport { ShopWorkAgent } from "./ShopWork.ts";',
      ),
    ).toEqual([{ line: 2, specifier: "./ShopWork.ts", allowed: ["Host"] }]);
  });

  it("ShopWork importing Billing is allowed", () => {
    expect(
      RulesLint.objectImportHits(
        "lib/agent/ShopWork.ts",
        'import { BillingAgent } from "./Billing.ts";\nimport { ShopAgentHost } from "./Host.ts";',
      ),
    ).toEqual([]);
  });

  it("Billing importing ShopWork is refused", () => {
    expect(
      RulesLint.objectImportHits(
        "lib/agent/Billing.ts",
        'import { ShopWorkAgent } from "@/lib/agent/ShopWork";',
      ),
    ).toEqual([
      {
        line: 1,
        specifier: "@/lib/agent/ShopWork",
        allowed: ["Host"],
      },
    ]);
  });

  it("a route importing @/lib/agent/ShopWork is refused", () => {
    expect(
      RulesLint.objectImportHits(
        "routes/app.index.tsx",
        'import * as Domain from "@/lib/Domain";\nimport { ShopWorkAgent } from "@/lib/agent/ShopWork";\nimport { ShopAgentHost } from "../lib/agent/Host.ts";',
      ),
    ).toEqual([
      { line: 2, specifier: "@/lib/agent/ShopWork" },
      { line: 3, specifier: "../lib/agent/Host.ts" },
    ]);
  });

  it("ShopAgent.ts importing all four is allowed", () => {
    expect(
      RulesLint.objectImportHits(
        "lib/ShopAgent.ts",
        [
          'import { BillingAgent } from "@/lib/agent/Billing";',
          'import { ShopAgentHost } from "@/lib/agent/Host";',
          'import { OrdersAgent } from "@/lib/agent/Orders";',
          'import { ShopWorkAgent } from "@/lib/agent/ShopWork";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("a model symbol never references a shape", () => {
  const suffixes = RulesLint.shapeSuffixes(barrel);

  it("the suffixes are read from the Shape families table", () => {
    expect(suffixes).toEqual([
      "LoaderData",
      "IndexData",
      "PageData",
      "ListData",
      "Command",
      "Result",
      "Input",
    ]);
  });

  it("a model function whose code names an input is refused; a shape naming the model, and a JSDoc link, are not", () => {
    const source = [
      "/** {@link SetRunNoteCommand} holds the rule. */",
      "export const RunNote = Schema.String;",
      "export const SetRunNoteCommand = Schema.Struct({ note: RunNote });",
      "export type SetRunNoteCommand = typeof SetRunNoteCommand.Type;",
      "// SetRunNoteCommand in a line comment",
      "export const runNoteOf = (command: SetRunNoteCommand) => command.note;",
      "const helper = (input: StartTaskInput) => input;",
      "export const StartTaskInput = Schema.Struct({});",
    ].join("\n");
    expect(RulesLint.modelShapeReferenceHits(source, suffixes)).toEqual([
      { name: "runNoteOf", line: 6, shape: "SetRunNoteCommand" },
      { name: "helper", line: 7, shape: "StartTaskInput" },
    ]);
  });

  it("a name that ends in a suffix but is not an export of the file is not a shape", () => {
    expect(
      RulesLint.modelShapeReferenceHits(
        'import { LoginInput } from "./Platform.ts";\nexport const login = (input: LoginInput) => input;',
        suffixes,
      ),
    ).toEqual([]);
  });
});

describe("the object holds nothing that keeps it from hibernating", () => {
  it("setTimeout, setInterval and new WebSocket are refused in the object and its modules", () => {
    const source = [
      "const a = setTimeout(() => {}, 10);",
      "const b = setInterval(() => {}, 10);",
      'const c = new WebSocket("wss://example.com");',
      "// setTimeout(() => {}) in a comment is not read",
      "const d = new WebSocketRequestResponsePair(ping, pong);",
    ].join("\n");
    expect(
      RulesLint.hibernationBlockerHits("lib/ShopAgent.ts", source),
    ).toStrictEqual([
      { line: 1, call: "setTimeout(" },
      { line: 2, call: "setInterval(" },
      { line: 3, call: "new WebSocket(" },
    ]);
    expect(
      RulesLint.hibernationBlockerHits("lib/agent/ShopWork.ts", source),
    ).toHaveLength(3);
    expect(
      RulesLint.hibernationBlockerHits("lib/useLiveQuery.ts", source),
    ).toHaveLength(0);
  });
});

describe("layout primitives and layout props are refused outside src/components/screen/", () => {
  it("layout elements, layout attributes and spread layout keys are refused", () => {
    const source = [
      '<s-stack gap="base">',
      '  <s-box padding="base" paddingBlockEnd="none">',
      '    <s-grid gridTemplateColumns="1fr auto">',
      '      <div className="x" style={{}} />',
      "    </s-grid>",
      "  </s-box>",
      "</s-stack>",
      "<s-query-container />",
      'const slotted = { paddingInlineStart: "small" };',
    ].join("\n");
    expect(
      RulesLint.layoutHits(source).map(({ line, text }) => [line, text]),
    ).toEqual([
      [1, "<s-stack"],
      [1, "gap="],
      [2, "<s-box"],
      [2, "padding="],
      [2, "paddingBlockEnd="],
      [3, "<s-grid"],
      [3, "gridTemplateColumns="],
      [4, "className="],
      [4, "style="],
      [8, "<s-query-container"],
      [9, "paddingInlineStart:"],
    ]);
  });

  it("content elements and comments naming a layout element are allowed", () => {
    const source = [
      "/** The row is an `s-grid` with `gap` in the part. */",
      '<s-section heading="Items">',
      '  {/* not an <s-box padding="base"> */}',
      '  <s-text color="subdued">Ready</s-text>',
      "  <s-table><s-table-body /></s-table>",
      "</s-section>",
    ].join("\n");
    expect(RulesLint.layoutHits(source)).toEqual([]);
  });
});
