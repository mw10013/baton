import { describe, expect, it } from "vitest";

import barrel from "@/lib/Domain.ts?raw";

import * as RulesLint from "../../scripts/lib/rules-lint.ts";

/**
 * `scripts/lib/rules-lint.ts` on inline sources. Pure, so it runs in the
 * workers pool like `spec.test.ts`.
 */

const hits = (source: string, tsx = true) =>
  RulesLint.retiredCopyHits(source, tsx).map(({ line }) => line);

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

  it("skips comments, identifiers, paths and query keys", () => {
    const source = [
      "// Cancel run",
      "/* the run",
      " * is done */",
      "{/* Every run */}",
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      'const key = ["shop-runs", run.status, "run-actions-1", `${run}`];',
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

describe("an exported identifier carries no reserved stem", () => {
  it("refuses a stem anywhere in an exported name, in any case, and leaves locals and the allowed names alone", () => {
    const source = [
      "export const isActive = () => true;",
      "export type TeamRoster = { id: string };",
      "export const RunTier = 1;",
      "const rosterAtCeiling = 1;",
      "export const CopySlot = 1;",
      "export const workflowIsOn = () => true;",
    ].join("\n");
    expect(RulesLint.reservedStemHits(source)).toEqual([
      { name: "isActive", line: 1, kind: "const" },
      { name: "TeamRoster", line: 2, kind: "type" },
      { name: "RunTier", line: 3, kind: "const" },
    ]);
  });
  it("an export named ProductionAgent is refused", () => {
    expect(
      RulesLint.reservedStemHits("export class ProductionAgent {}"),
    ).toEqual([{ name: "ProductionAgent", line: 1, kind: "class" }]);
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

  it("Orders importing ShopWork is refused", () => {
    expect(
      importHits(
        "lib/domain/Orders.ts",
        [
          'import { Schema } from "effect";',
          "",
          'import { WorkflowId } from "./Platform.ts";',
          "import {",
          "  RunStatus,",
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
