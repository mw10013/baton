import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Page } from "../../../../src/backend/membership-repository.ts";
import { TeamLimitError, TeamNameTakenError } from "../../../../src/contract/members.ts";
import { Team, type TeamName, TeamSummary } from "../../../../src/domain/shop-work.ts";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import TeamsIndexPage from "../../../../src/web/components/TeamsIndexPage.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const summary = (name: string, memberCount: number) =>
  Schema.decodeUnknownSync(TeamSummary)({
    id: `team-${name}`,
    shop: SEED_SHOP,
    name,
    createdAt: 0,
    memberCount,
  });

const pageOf = (rows: ReadonlyArray<TeamSummary>): Page<TeamSummary, TeamName> => ({
  rows,
  nextCursor: null,
  matches: null,
});

beforeEach(() => {
  globalThis.shopify = {
    idToken: () => Promise.resolve("token"),
    modal: { hide: () => Promise.resolve() },
    toast: { show: () => {} },
  };
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

const render = (
  page: Page<TeamSummary, TeamName>,
  options: {
    created?: Effect.Effect<Team, TeamLimitError | TeamNameTakenError>;
    onCreated?: (team: Team) => Promise<void>;
  } = {},
) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <TeamsIndexPage
        page={page}
        q={null}
        after={null}
        teamLink={(id) => ({
          href: `/app/teams/${id}`,
          onClick: (event) => event.preventDefault(),
        })}
        onSearch={() => {}}
        onNextPage={() => {}}
        onPreviousPage={() => {}}
        onCreated={options.onCreated ?? (async () => {})}
      />
    </ShopSocket>,
    shopTestRegistry({
      MerchantCreateTeam: ({ name }) =>
        options.created ??
        Effect.succeed(
          Schema.decodeUnknownSync(Team)({ id: "team-new", shop: SEED_SHOP, name, createdAt: 0 }),
        ),
    }),
  );

/** Opens Create team from the empty state (the title bar's copy is folded away off the admin). */
const create = async (screen: Awaited<ReturnType<typeof render>>, name: string) => {
  await screen.getByRole("button", { name: "Create team" }).last().click();
  await screen.getByRole("textbox", { name: "Name" }).fill(name);
  await screen.getByRole("button", { name: "Create", exact: true }).click();
};

describe("TeamsIndexPage", () => {
  it("lists each team as a link with its member count, and No members for an empty one", async () => {
    const screen = await render(pageOf([summary("Cut", 3), summary("Sew", 0)]));
    await expect
      .element(screen.getByRole("link", { name: "Cut" }))
      .toHaveAttribute("href", "/app/teams/team-Cut");
    await expect.element(screen.getByText("3", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("No members")).toBeVisible();
  });

  it("a shop with no teams is the empty state, with Create team", async () => {
    const screen = await render(pageOf([]));
    await expect.element(screen.getByText("No teams yet")).toBeVisible();
  });

  it("Create team sends the trimmed name and hands the team on", async () => {
    const created: Array<string> = [];
    const screen = await render(pageOf([]), {
      onCreated: async (team) => {
        created.push(team.name);
      },
    });
    await create(screen, "  Cut & Sew  ");
    await expect.poll(() => created).toStrictEqual(["Cut & Sew"]);
  });

  it("a taken name is the field's error, and the team limit is the banner", async () => {
    const taken = await render(pageOf([]), {
      created: Effect.fail(new TeamNameTakenError({ shop: SEED_SHOP, name: "Cut" as TeamName })),
    });
    await create(taken, "Cut");
    await expect.element(taken.getByText("A team with that name already exists.")).toBeVisible();
    await taken.unmount();
    const full = await render(pageOf([]), {
      created: Effect.fail(new TeamLimitError({ shop: SEED_SHOP, limit: 50 })),
    });
    await create(full, "One too many");
    await expect
      .element(full.getByText("A shop can have 50 teams. Delete one to add another."))
      .toBeVisible();
  });

  it("a name past 32 characters is refused on Create with the field's own error", async () => {
    const screen = await render(pageOf([]));
    await create(screen, "x".repeat(33));
    await expect.element(screen.getByText("Up to 32 characters")).toBeVisible();
  });
});
