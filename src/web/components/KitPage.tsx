import type { ListSearch, Run, TaskWithTeamName } from "../../domain/shop-work.ts";
import {
  ORDERS_SHOW_LABEL,
  TASK_INSTRUCTIONS_MAX_LENGTH,
  VERB_LABEL,
  WORKFLOW_STATE_LABEL,
} from "../../domain/shop-work.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { BlockBanner, ClosedLine, RunItem, RunNote } from "./MemberRun.tsx";
import { type RunStepTask, RunSteps } from "./RunSteps.tsx";
import { BlockModal, RunNoteModal } from "./RunTextModals.tsx";
import { BackLink } from "./screen/BackLink.tsx";
import { Clamp } from "./screen/Clamp.tsx";
import { ClampedProse } from "./screen/ClampedProse.tsx";
import { Connector } from "./screen/Connector.tsx";
import { EmptyAside } from "./screen/EmptyAside.tsx";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { Fields } from "./screen/Fields.tsx";
import { FilterRow } from "./screen/FilterRow.tsx";
import { FootLine } from "./screen/FootLine.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { Name } from "./screen/Name.tsx";
import { PageNote } from "./screen/PageNote.tsx";
import { Panel } from "./screen/Panel.tsx";
import { Prose } from "./screen/Prose.tsx";
import { SearchLine } from "./screen/SearchLine.tsx";
import { SelectableCard } from "./screen/SelectableCard.tsx";
import { SetupGuide, type SetupGuideStep } from "./screen/SetupGuide.tsx";
import { Strip } from "./screen/Strip.tsx";
import { textLimitError, textLimitProps } from "./screen/TextLimit.tsx";
import { Token } from "./screen/Token.tsx";
import { StepFlow } from "./WorkflowSteps.tsx";

/** A 255-character item title, Shopify's limit. */
const TITLE_255 =
  "Engraved cutting board, extra large end-grain walnut with a hand-cut juice groove, rounded finger grips, a personalized inscription across the front face, a food-safe oil finish, and gift wrapping for the day it is given, packed in a box";
/** 64 characters, `NAME_MAX_LENGTH`. */
const TASK_64 = "Condition and burnish the edges against the customer's reference";
const TASK_64_B = "Engrave the inscription across the full width of the front face";
/** 32 characters, `TEAM_NAME_MAX_LENGTH`. */
const TEAM_32 = "Hand stitching and edge painting";
/** 1000 characters, `BLOCK_REASON_MAX_LENGTH`. */
const REASON_1000 =
  "The crest is a scan of a wax seal and the fine lines fill in at this depth; we have tried three passes and it still reads as a smudge, so we are waiting on vector artwork from the customer. "
    .repeat(6)
    .slice(0, 1000);
/** 255 characters with no space: a workflow tag at Shopify's limit. */
const TAG_255 = "engraved-boards-rush-and-standard-".repeat(8).slice(0, 255);

/** A variant title as long as the seed's longest. */
const VARIANT = "Solid 18k yellow gold / Size 11½ / Extra-deep engraving";
/** 60 characters: a member's email as long as the seed's longest. */
const EMAIL_60 = "alexandra.featherstonehaugh@example-workshop-and-studios.com";
/** An order name with a prefix and suffix, as long as a shop's order format makes one. */
const ORDER = "#WEB-1000234-EU";

/** A date whose "Last updated on" line is the longest: a two-digit day in September. */
const UPDATED_AT = Date.UTC(2026, 8, 30, 23, 59);

/** A worst-case task: the longest name and team, the longest instructions. */
const taskOf = (index: number, step: number): TaskWithTeamName =>
  ({
    id: `task-${String(index)}`,
    position: index + 1,
    step,
    name: index % 2 === 0 ? TASK_64 : TASK_64_B,
    teamId: "team-1",
    instructions: index === 0 ? REASON_1000.slice(0, TASK_INSTRUCTIONS_MAX_LENGTH) : null,
    teamName: TEAM_32,
    memberCount: index === 1 ? 0 : 3,
  }) as TaskWithTeamName;

/** A 20-task parallel step after a one-task step: no cap on a step's cards. */
const TASKS_20 = [taskOf(0, 1), ...Array.from({ length: 20 }, (_, index) => taskOf(index + 1, 2))];

/**
 * A worst-case run task: the longest names, the longest email as its actor, each state in turn
 * (done, started, ready, waiting) by its index.
 */
const runTaskOf = (index: number, step: number, state: "done" | "started" | "ready" | "waiting") =>
  ({
    id: `run-task-${String(index)}`,
    runId: "run-1",
    position: index + 1,
    step,
    name: index % 2 === 0 ? TASK_64 : TASK_64_B,
    teamId: "team-1",
    teamName: TEAM_32,
    instructions: index === 0 ? REASON_1000.slice(0, TASK_INSTRUCTIONS_MAX_LENGTH) : null,
    startedAt: state === "done" || state === "started" ? UPDATED_AT : null,
    startedByEmail: state === "done" || state === "started" ? EMAIL_60 : null,
    startedByRole: state === "done" || state === "started" ? "member" : null,
    doneAt: state === "done" ? UPDATED_AT : null,
    doneByEmail: null,
    doneByRole: state === "done" ? "merchant" : null,
    current: state === "started" || state === "ready",
  }) as unknown as RunStepTask;

/** A done step, a parallel step of 20 (started and ready), and a waiting step. */
const RUN_TASKS: readonly RunStepTask[] = [
  runTaskOf(0, 1, "done"),
  ...Array.from({ length: 20 }, (_, index) =>
    runTaskOf(index + 1, 2, index % 2 === 0 ? "started" : "ready"),
  ),
  runTaskOf(21, 3, "waiting"),
];

/** A worst-case run: blocked with the longest reason by the longest email, noted, closed, with properties. */
const RUN = {
  orderName: ORDER,
  lineItemTitle: TITLE_255,
  variantTitle: VARIANT,
  quantity: 1200,
  sku: TAG_255,
  lineItemProperties: [
    { key: "Engraving", value: "The Millers · est. 2019" },
    { key: "_app_internal_reference_key_that_has_no_spaces_at_all", value: TITLE_255 },
    { key: "Gift note", value: null },
  ],
  blockedAt: UPDATED_AT,
  blockReason: REASON_1000,
  blockedBy: { role: "member", email: EMAIL_60 },
  note: REASON_1000,
  state: "closed",
  closedAt: UPDATED_AT,
  closedReason: "item_removed",
} as unknown as Run;

/** The five cells every strip has, with the workflows list's longest labels. */
const STRIP_LABELS = ["Started by you", "Started by others", "Ready", "Blocked", "Done or closed"];

/** The orders strip's five values, the home page's link cells. */
const ORDERS_STRIP = ["no_workflow", "not_started", "making", "made", "issues"] as const;

/**
 * The home page's setup guide in each state: `done` marks the steps done, in order. The strings
 * are the home page's.
 */
const setupSteps = (done: number): readonly SetupGuideStep[] => {
  const steps = [
    {
      key: "teamWithMember",
      sentence: "Create a team and add a member",
      link: { label: "Teams", href: "/dev/kit" },
    },
    {
      key: "activeWorkflow",
      sentence: "Create a workflow and turn it on",
      link: { label: "Workflows", href: "/dev/kit" },
    },
    {
      key: "run",
      sentence: "An item gets a workflow",
      body: "New orders arrive as they are placed.",
    },
  ];
  return steps.map((step, index) => ({
    ...step,
    done: index < done,
    state: index < done ? "Done" : "Not done",
  }));
};

const noop = () => {};
const resolveNull = () => Promise.resolve(null);

/**
 * The kit page: every part under `src/web/components/screen/` rendered once, filled with the
 * worst cases, static data only. A shape change starts at the part's row, then the part, then
 * here, then the screens; the screenshots of this page at 375px and 1280px are what a part change
 * is reviewed against, so nobody has to walk every screen to see whether the app is consistent.
 * `width` renders it in the member's page width (`small`) or the merchant's (`large`).
 *
 * Legacy's sections whose parts are not ported yet (`ResourceRow`, `ShowMore`, the help parts)
 * come with their slices; the step flow, selectable card, fields, panel, empty aside, connector,
 * text-limit and run sections are new here.
 */
export function KitPage({ width }: { readonly width: "small" | "large" }) {
  const search = <ListSearchField value={null} placeholder="Search by name" onSubmit={noop} />;
  const longDraft = "x".repeat(TASK_INSTRUCTIONS_MAX_LENGTH - 20);
  return (
    <>
      <BackLink label="Workflows" href="/dev/kit" />
      <s-page heading="Kit" inlineSize={width}>
        <IndexSection
          label="Search"
          head={
            <>
              <Strip
                cells={STRIP_LABELS.map((label, index) => ({
                  key: label,
                  label,
                  count: index * 7,
                  chosen: index === 2,
                  onSelect: noop,
                }))}
              />
              <SearchLine
                count={3}
                noun={["workflow", "workflows"]}
                term={"#1030" as ListSearch}
                onClear={noop}
              />
              <FilterRow search={search} />
            </>
          }
        >
          <EmptyLine action={<s-button>Clear search</s-button>}>
            No workflow matches #9999
          </EmptyLine>
        </IndexSection>
        {[0, 1, 2].map((done) => (
          <SetupGuide
            key={done}
            heading="Getting started"
            count={`${String(done)} of 3 done`}
            steps={setupSteps(done)}
          />
        ))}
        {/* All three done: the home page leaves the guide out, so its place is empty. */}
        <s-section heading="Setup guide, all done" />
        {/* The home page's strip: the same cells as links, nothing chosen. */}
        <s-section heading="Orders">
          <Strip
            cells={ORDERS_STRIP.map((key, index) => ({
              key,
              label: ORDERS_SHOW_LABEL[key],
              count: 1000 + index * 120,
              href: "/dev/kit",
              onClick: noop,
            }))}
          />
        </s-section>
        <IndexSection
          label="Workflows index"
          head={
            <FilterRow
              main={
                <Inline>
                  <s-press-button variant="tertiary" pressed>
                    All
                  </s-press-button>
                  <s-press-button variant="tertiary">{WORKFLOW_STATE_LABEL.active}</s-press-button>
                  <s-press-button variant="tertiary">
                    {WORKFLOW_STATE_LABEL.inactive}
                  </s-press-button>
                </Inline>
              }
              search={search}
            />
          }
        >
          <EmptyLine heading="No workflows yet" />
        </IndexSection>
        <IndexSection label="Empty">
          <EmptyLine
            heading="No open orders"
            action={<s-button variant="primary">Sync open orders</s-button>}
          >
            Press Sync open orders to bring in your open orders from the last 30 days, or wait for
            the next order.
          </EmptyLine>
        </IndexSection>
        <PageNote>
          Last updated on <LocalDateTime value={UPDATED_AT} />
        </PageNote>
        <s-section heading="Text fits">
          <s-paragraph>
            <Name>{TASK_64}</Name>
          </s-paragraph>
          <Clamp>{`${TITLE_255} · ${VARIANT}`}</Clamp>
          <Clamp heading>{TITLE_255}</Clamp>
          <s-paragraph>
            <Token color="subdued">{TAG_255}</Token>
          </s-paragraph>
          <s-paragraph>
            <Token>{TITLE_255}</Token>
          </s-paragraph>
          <Prose>{REASON_1000}</Prose>
          <ClampedProse>{REASON_1000}</ClampedProse>
        </s-section>
        {/* New: the run pieces the member's workflow page and the merchant's order page share. */}
        <s-section heading="Run">
          <Lines>
            <s-heading>{TITLE_255}</s-heading>
            <RunItem run={RUN} />
            <ClosedLine run={RUN} viewer="member" prefix />
            <BlockBanner
              run={RUN}
              viewer="merchant"
              actions={<s-button slot="secondary-actions">{VERB_LABEL.unblock.merchant}</s-button>}
            />
            <RunNote note={RUN.note} canEdit pending={false} onEdit={noop} />
            <Inline>
              <s-button commandFor="kit-note" command="--show">
                {VERB_LABEL.note.member}
              </s-button>
              <s-button commandFor="kit-block" command="--show">
                {VERB_LABEL.block.member}
              </s-button>
            </Inline>
          </Lines>
          <RunNoteModal id="kit-note" note={RUN.note} pending={false} onSave={resolveNull} />
          <BlockModal id="kit-block" run={RUN} pending={false} onBlock={resolveNull} />
        </s-section>
        <s-section heading="Run steps">
          <RunSteps
            tasks={RUN_TASKS}
            viewer="merchant"
            showInstructions
            renderActions={(task) =>
              task.current ? <s-button>{VERB_LABEL.done.member}</s-button> : null
            }
          />
        </s-section>
        {/* New: the step flow with a 20-task step, the workflow page's and the editor's shape. */}
        <s-section heading="Step flow">
          <StepFlow
            tasks={TASKS_20}
            trigger={
              <Panel kind="card">
                <Lines>
                  <s-heading>Tag</s-heading>
                  <Token color="subdued">{`Starts when an order contains a product tagged “${TAG_255}”.`}</Token>
                </Lines>
              </Panel>
            }
          />
        </s-section>
        {/* New: the editor's chosen and unchosen cards, and the add form's draft panel. */}
        <s-section heading="Selectable card">
          <Lines>
            <SelectableCard selected accessibilityLabel="Edit chosen" onSelect={noop}>
              <s-heading>{TASK_64}</s-heading>
            </SelectableCard>
            <Connector />
            <SelectableCard selected={false} accessibilityLabel="Edit unchosen" onSelect={noop}>
              <s-heading>{TASK_64_B}</s-heading>
            </SelectableCard>
          </Lines>
        </s-section>
        <s-section heading="Panel">
          <Lines>
            <Panel kind="card">
              <s-text>card</s-text>
            </Panel>
            <Panel kind="drawer">
              <s-text>drawer</s-text>
            </Panel>
            <Panel kind="draft">
              <s-text>draft</s-text>
            </Panel>
          </Lines>
        </s-section>
        {/* New: a form's fields with an error under each, and the text limit's countdown. */}
        <s-section heading="Fields and text limit">
          <Fields>
            <s-text-field
              label="Name"
              value={`${TASK_64}x`}
              error={textLimitError(`${TASK_64}x`, 64) ?? undefined}
            />
            <s-text-area
              label="Instructions"
              rows={3}
              value={longDraft}
              {...textLimitProps(longDraft, TASK_INSTRUCTIONS_MAX_LENGTH)}
            />
          </Fields>
        </s-section>
        <EmptyAside />
        <FootLine>Learn more in Editing steps and tasks.</FootLine>
      </s-page>
    </>
  );
}
