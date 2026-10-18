import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type DeleteTeamResult, TeamDetail } from "../../../../src/domain/shop-work.ts";
import type { PageLink } from "../../../../src/web/components/MembersIndexPage.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import TeamPage from "../../../../src/web/components/TeamPage.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const memberOf = (name: string) => ({
  id: `mem-${name}`,
  shop: SEED_SHOP,
  email: `${name}@m.com`,
  createdAt: 0,
});

const detailOf = (members: ReadonlyArray<string>, candidates: ReadonlyArray<string> = []) =>
  Schema.decodeUnknownSync(TeamDetail)({
    team: { id: "team-1", shop: SEED_SHOP, name: "Cut", createdAt: 0 },
    members: members.map(memberOf),
    memberCount: members.length,
    nextCursor: null,
    candidates: candidates.map(memberOf),
  });

const link = (href: string): PageLink => ({ href, onClick: (event) => event.preventDefault() });

let toasts: Array<string> = [];
beforeEach(() => {
  toasts = [];
  globalThis.shopify = {
    idToken: () => Promise.resolve("token"),
    modal: { hide: () => Promise.resolve() },
    toast: {
      show: (message) => {
        toasts.push(message);
      },
    },
  };
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

/** The page over the in-memory actor; `calls` records each write, `deleted` is Delete's answer. */
const render = (
  detail: TeamDetail | null,
  options: {
    calls?: Array<string>;
    deleted?: DeleteTeamResult;
    onChanged?: () => Promise<void>;
    onDeleted?: () => Promise<void>;
  } = {},
) => {
  const calls = options.calls ?? [];
  return renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <TeamPage
        detail={detail}
        membersAfter={null}
        teamsLink={link("/app/teams")}
        membersLink={link("/app/members")}
        memberLink={(id) => link(`/app/members/${id}`)}
        onNextPage={() => {}}
        onPreviousPage={() => {}}
        onChanged={options.onChanged ?? (async () => {})}
        onDeleted={options.onDeleted ?? (async () => {})}
      />
    </ShopSocket>,
    shopTestRegistry({
      MerchantSetTeamMember: (input) =>
        Effect.sync(() => {
          calls.push(`SetTeamMember ${input.teamId} ${input.memberId} ${String(input.inTeam)}`);
        }),
      MerchantAddTeamMembers: ({ memberIds }) =>
        Effect.sync(() => {
          calls.push(`AddTeamMembers ${memberIds.join(",")}`);
        }),
      MerchantDeleteTeam: ({ teamId }) =>
        Effect.sync(() => {
          calls.push(`DeleteTeam ${teamId}`);
          return options.deleted ?? { _tag: "Deleted" as const };
        }),
    }),
  );
};

/** Presses the Delete modal's primary: its opener is in More actions, off the test page. */
const pressDelete = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.container
    .querySelector("s-modal#delete-team")
    ?.querySelector<HTMLElement>('s-button[slot="primary-action"]')
    ?.click();

describe("TeamPage", () => {
  it("a stale id is Team not found", async () => {
    const screen = await render(null);
    await expect.element(screen.getByText("That team no longer exists.")).toBeVisible();
  });

  it("a team with nobody on it says so, with Add members", async () => {
    const screen = await render(detailOf([], ["ana"]));
    await expect.element(screen.getByText("Nobody on this team yet")).toBeVisible();
  });

  it("lists the team's members as links, and Remove takes one off, then re-reads", async () => {
    const calls: Array<string> = [];
    let changed = 0;
    const screen = await render(detailOf(["ana", "ben"]), {
      calls,
      onChanged: async () => {
        changed += 1;
      },
    });
    await expect
      .element(screen.getByRole("link", { name: "ana@m.com" }))
      .toHaveAttribute("href", "/app/members/mem-ana");
    await screen.getByRole("button", { name: "Remove" }).first().click();
    await expect.poll(() => calls).toStrictEqual(["SetTeamMember team-1 mem-ana false"]);
    await expect.poll(() => changed).toBe(1);
  });

  it("Add members adds the ticked members, then re-reads", async () => {
    const calls: Array<string> = [];
    const screen = await render(detailOf([], ["ana", "ben"]), { calls });
    await screen.getByRole("button", { name: "Add members" }).last().click();
    await screen.getByRole("checkbox", { name: "ben@m.com" }).click();
    await screen.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => calls).toStrictEqual(["AddTeamMembers mem-ben"]);
  });

  it("Delete team deleted toasts Team deleted and leaves", async () => {
    const calls: Array<string> = [];
    let left = 0;
    const screen = await render(detailOf(["ana"]), {
      calls,
      onDeleted: async () => {
        left += 1;
      },
    });
    pressDelete(screen);
    await expect.poll(() => calls).toStrictEqual(["DeleteTeam team-1"]);
    await expect.poll(() => toasts).toStrictEqual(["Team deleted"]);
    expect(left).toBe(1);
  });

  it("Delete team of a team already gone says so and stays", async () => {
    let left = 0;
    const screen = await render(detailOf(["ana"]), {
      deleted: { _tag: "NotFound" },
      onDeleted: async () => {
        left += 1;
      },
    });
    pressDelete(screen);
    await expect.element(screen.getByText("That team no longer exists.")).toBeVisible();
    expect(toasts).toStrictEqual([]);
    expect(left).toBe(0);
  });
});
