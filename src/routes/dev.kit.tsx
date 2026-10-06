import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { BackLink } from "@/components/screen/BackLink";
import { Clamp } from "@/components/screen/Clamp";
import { ClampedProse } from "@/components/screen/ClampedProse";
import { EmptyLine } from "@/components/screen/EmptyLine";
import { FilterRow } from "@/components/screen/FilterRow";
import { IndexSection } from "@/components/screen/IndexSection";
import { Inline } from "@/components/screen/Inline";
import { ListSearchField } from "@/components/screen/ListSearchField";
import { Name } from "@/components/screen/Name";
import { PageNote } from "@/components/screen/PageNote";
import { Prose } from "@/components/screen/Prose";
import { ResourceRow, RowLine } from "@/components/screen/ResourceRow";
import { SearchLine } from "@/components/screen/SearchLine";
import { ShowMore } from "@/components/screen/ShowMore";
import { Strip } from "@/components/screen/Strip";
import { Token } from "@/components/screen/Token";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { STATE_LABEL, STATES } from "@/lib/workflowsListStates";

/**
 * The kit page exists only on the local dev server, as `/api/dev/seed` does:
 * a deployed environment answers not found.
 */
const requireLocal = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const env = yield* CloudflareEnv;
        if (env.ENVIRONMENT !== "local") return yield* Effect.fail(notFound());
        return null;
      }),
    ),
);

const KitSearch = Schema.Struct({
  /** The page width the parts render in: the member's (`small`, the default) or the merchant's (`large`). */
  width: Schema.optionalKey(Schema.Literals(["small", "large"])),
});

/**
 * The kit page: every part of the parts table (`ScreenPart` in
 * `src/lib/Screen.ts`) rendered once, filled with the seed's worst cases,
 * static data only. A shape change starts at the part's row, then the part,
 * then here, then the screens; the screenshots of this page at 375px and
 * 1280px are what a part change is reviewed against, so nobody has to walk
 * every screen to see whether the app is consistent.
 *
 * Not a merchant or member screen, so it has no Screens row: it is a dev
 * page, gated like `/api/dev/seed`. `?width=large` renders it in the
 * merchant's page width, `small` (the default) in the member's.
 */
export const Route = createFileRoute("/dev/kit")({
  validateSearch: Schema.toStandardSchemaV1(KitSearch),
  beforeLoad: () => requireLocal(),
  head: () => ({ meta: [{ title: "Kit — Baton" }] }),
  component: RouteComponent,
});

/** A 255-character item title, Shopify's limit. */
const TITLE_255 =
  "Engraved cutting board, extra large end-grain walnut with a hand-cut juice groove, rounded finger grips, a personalized inscription across the front face, a food-safe oil finish, and gift wrapping for the day it is given, packed in a box";
const VARIANT = "Solid 18k yellow gold / Size 11½ / Extra-deep engraving";
/** 64 characters, `NAME_MAX_LENGTH`. */
const TASK_64 =
  "Condition and burnish the edges against the customer's reference";
const TASK_64_B =
  "Engrave the inscription across the full width of the front face";
const WORKFLOW_64 =
  "Engraved boards, rush and standard, with the inscription proof ";
/** 32 characters, `TEAM_NAME_MAX_LENGTH`. */
const TEAM_32 = "Hand stitching and edge painting";
/** 1000 characters, `BLOCK_REASON_MAX_LENGTH`. */
const REASON_1000 =
  "The crest is a scan of a wax seal and the fine lines fill in at this depth; we have tried three passes and it still reads as a smudge, so we are waiting on vector artwork from the customer. "
    .repeat(6)
    .slice(0, 1000);
const EMAIL_60 = "alexandra.featherstonehaugh@example-workshop-and-studios.com";
const ORDER = "#WEB-1000234-EU";
/** 255 characters with no space: a workflow tag at Shopify's limit. */
const TAG_255 = "engraved-boards-rush-and-standard-".repeat(8).slice(0, 255);

/** A 20-task parallel step: no cap on a row's task lines. */
const TASKS_20 = Array.from({ length: 20 }, (_, index) =>
  index % 2 === 0 ? TASK_64 : TASK_64_B,
);

/** A date whose "Last updated on" line is the longest: a two-digit day in September. */
const UPDATED_AT = Date.UTC(2026, 8, 30, 23, 59);

const ORDER_STRIP: readonly (keyof Domain.OrderCounts)[] = [
  "open",
  "not_started",
  "making",
  "made",
  "issues",
];

const noop = () => {
  /* static data: nothing to do */
};

function RouteComponent() {
  const { width = "small" } = Route.useSearch();
  const select = (label: string, any: string) => (
    <s-select label={label} labelAccessibilityVisibility="exclusive">
      <s-option value="any">{any}</s-option>
      <s-option value="t">{TEAM_32}</s-option>
    </s-select>
  );
  const search = <ListSearchField value={null} onSubmit={noop} />;
  const menu = {
    label: "Actions",
    disabled: false,
    items: <s-button>Start</s-button>,
  };
  const href = "/dev/kit";
  return (
    <>
      <BackLink label="Workflows" href={href} onNavigate={noop} />
      <s-page heading="Kit" inlineSize={width}>
        <IndexSection
          label="Workflows list"
          head={
            <>
              <Strip
                cells={STATES.map((state, index) => ({
                  key: state,
                  label: STATE_LABEL[state],
                  count: index * 7,
                  chosen: index === 2,
                  onSelect: noop,
                }))}
              />
              <FilterRow
                search={search}
                secondary={select("Team", "Any team")}
              />
            </>
          }
        >
          <ResourceRow
            head={{ lead: "#1008", title: "Signet ring · Gold", trail: "×2" }}
            menu={menu}
            href={href}
            onNavigate={noop}
            accessibilityLabel="Open Signet ring · Gold ×2 on #1008"
          >
            <RowLine>
              <Name>Engrave crest</Name>
              <s-text color="subdued"> (Engraving)</s-text>
            </RowLine>
            <RowLine>
              <Clamp color="subdued">
                Crest file missing from the order — asked the customer.
              </Clamp>
            </RowLine>
            <RowLine>
              <s-text color="subdued">Step 2 of 3</s-text>
            </RowLine>
          </ResourceRow>
          <ResourceRow
            head={{ lead: "#1026", title: TITLE_255, trail: null }}
            menu={menu}
            href={href}
            onNavigate={noop}
            accessibilityLabel="Open the 255-character title on #1026"
          >
            <RowLine>
              <Name>Engrave</Name>
              <s-text color="subdued"> (Engraving)</s-text>
            </RowLine>
            <RowLine>
              <Clamp color="subdued">{REASON_1000}</Clamp>
            </RowLine>
            <RowLine>
              <s-text color="subdued">
                Cut, engrave and oil · Step 2 of 3
              </s-text>
            </RowLine>
          </ResourceRow>
          <ResourceRow
            head={{
              lead: ORDER,
              title: `${TITLE_255} · ${VARIANT}`,
              trail: "×12",
            }}
            menu={menu}
            href={href}
            onNavigate={noop}
            accessibilityLabel={`Open the longest piece on ${ORDER}`}
          >
            <RowLine>
              <Name>{TASK_64_B}</Name>
              <s-text color="subdued">{` (${TEAM_32}) · Started by `}</s-text>
              <Token color="subdued">{EMAIL_60}</Token>
            </RowLine>
            <RowLine>
              <Name color="subdued">{WORKFLOW_64}</Name>
              <s-text color="subdued"> · Step 14 of 18</s-text>
            </RowLine>
          </ResourceRow>
          <ResourceRow
            head={{
              lead: "#1030",
              title: "Heirloom leather journal",
              trail: null,
            }}
            menu={menu}
            href={href}
            onNavigate={noop}
            accessibilityLabel="Open a 20-task step on #1030"
          >
            {TASKS_20.map((task, index) => (
              <RowLine key={index}>
                <Name>{task}</Name>
                <s-text color="subdued">{` (${TEAM_32}) · Ready`}</s-text>
              </RowLine>
            ))}
            <RowLine>
              <s-text color="subdued">Step 2 of 18</s-text>
            </RowLine>
          </ResourceRow>
          <ResourceRow
            head={{
              lead: "#1030",
              title: "Heirloom leather journal",
              trail: null,
            }}
            menu={null}
            href={href}
            onNavigate={noop}
            accessibilityLabel="Open a done row on #1030"
          >
            <RowLine>
              <Name>{TASK_64}</Name>
              <s-text color="subdued"> · Done by you · 12:51 PM</s-text>
            </RowLine>
          </ResourceRow>
          <ShowMore hidden={40} page={25} end={null} onShowMore={noop} />
        </IndexSection>
        <IndexSection
          label="Search"
          head={
            <>
              <SearchLine
                count={3}
                noun={["workflow", "workflows"]}
                term="#1030"
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
        <IndexSection
          label="Orders index"
          head={
            <>
              <Strip
                cells={ORDER_STRIP.map((key, index) => ({
                  key,
                  label: Domain.ORDERS_SHOW_LABEL[key],
                  count: 1000 + index * 120,
                  chosen: index === 0,
                  onSelect: noop,
                }))}
              />
              <FilterRow
                main={select("Show", "Open")}
                search={search}
                secondary={select("Team", "Any team")}
              />
            </>
          }
        >
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Tag</s-table-header>
              <s-table-header listSlot="inline">Member</s-table-header>
            </s-table-header-row>
            <s-table-body>
              <s-table-row>
                <s-table-cell>
                  <Token>{ORDER}</Token>
                </s-table-cell>
                <s-table-cell>
                  <Token color="subdued">{TAG_255}</Token>
                </s-table-cell>
                <s-table-cell>
                  <Token href="/dev/kit">{EMAIL_60}</Token>
                </s-table-cell>
              </s-table-row>
            </s-table-body>
          </s-table>
        </IndexSection>
        <IndexSection
          label="Workflows index"
          head={
            <FilterRow
              main={
                <Inline>
                  <s-button variant="primary">All</s-button>
                  <s-button variant="tertiary">
                    {Domain.WORKFLOW_STATE_LABEL.active}
                  </s-button>
                  <s-button variant="tertiary">
                    {Domain.WORKFLOW_STATE_LABEL.inactive}
                  </s-button>
                </Inline>
              }
              search={search}
            />
          }
        />
        <IndexSection label="Deepest read">
          <ShowMore
            hidden={140}
            page={25}
            end="Showing 100 of 240. Search or choose a team to find the rest."
            onShowMore={noop}
          />
        </IndexSection>
        <IndexSection label="Empty">
          <EmptyLine
            heading="No open orders"
            action={<s-button variant="primary">Sync open orders</s-button>}
          >
            Sync open orders to pull in what is on the bench, or wait for the
            next order.
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
          <Prose>{REASON_1000}</Prose>
          <ClampedProse>{REASON_1000}</ClampedProse>
          <s-paragraph>
            <s-text>Started by you · Step 2 of 3 · 12:51 PM</s-text>
          </s-paragraph>
        </s-section>
        <s-section heading="Line one's weight">
          <s-paragraph>
            <s-text type="strong">
              s-text type=strong: Signet ring · Gold
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text {...{ fontWeight: "semibold" }}>
              s-text fontWeight=semibold: Signet ring · Gold
            </s-text>
          </s-paragraph>
          <s-heading lineClamp={2}>
            s-heading lineClamp: Signet ring · Gold
          </s-heading>
          <s-clickable href={href}>
            <s-heading lineClamp={2}>
              s-heading in s-clickable: Signet ring · Gold
            </s-heading>
          </s-clickable>
        </s-section>
      </s-page>
    </>
  );
}
