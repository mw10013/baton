import * as Effect from "effect/Effect";
import { installAppBridge } from "../../app-bridge.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { SetTeamMemberInput } from "../../../../src/contract/members.ts";
import { MemberDetail } from "../../../../src/domain/shop-work.ts";
import MemberPage from "../../../../src/web/components/MemberPage.tsx";
import type { PageLink } from "../../../../src/web/components/MembersIndexPage.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const detailOf = (teams: ReadonlyArray<string>, candidates: ReadonlyArray<string> = []) =>
  Schema.decodeUnknownSync(MemberDetail)({
    member: { id: "mem-1", shop: SEED_SHOP, email: "m1@m.com", createdAt: 0 },
    teams: teams.map((name) => ({ id: `team-${name}`, name })),
    teamCount: teams.length,
    nextCursor: null,
    candidates: candidates.map((name) => ({ id: `team-${name}`, name })),
  });

const link = (href: string): PageLink => ({ href, onClick: (event) => event.preventDefault() });

let toasts: Array<string> = [];
beforeEach(() => {
  toasts = [];
  installAppBridge({ toast: (message) => toasts.push(message) });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

/** The page over the in-memory actor; `calls` records each write's payload, by procedure. */
const render = (
  detail: MemberDetail | null,
  calls: Array<string> = [],
  hooks: { onChanged?: () => Promise<void>; onDeleted?: () => Promise<void> } = {},
) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <MemberPage
        detail={detail}
        teamsAfter={null}
        membersLink={link("/app/members")}
        teamsLink={link("/app/teams")}
        teamLink={(id) => link(`/app/teams/${id}`)}
        onNextPage={() => {}}
        onPreviousPage={() => {}}
        onChanged={hooks.onChanged ?? (async () => {})}
        onDeleted={hooks.onDeleted ?? (async () => {})}
      />
    </ShopSocket>,
    shopTestRegistry({
      MerchantSetTeamMember: (input: SetTeamMemberInput) =>
        Effect.sync(() => {
          calls.push(`SetTeamMember ${input.teamId} ${input.memberId} ${String(input.inTeam)}`);
        }),
      MerchantAddMemberTeams: ({ teamIds }) =>
        Effect.sync(() => {
          calls.push(`AddMemberTeams ${teamIds.join(",")}`);
        }),
      MerchantDeleteMember: ({ email }) =>
        Effect.sync(() => {
          calls.push(`DeleteMember ${email}`);
        }),
    }),
  );

describe("MemberPage", () => {
  it("a stale id is Member not found", async () => {
    const screen = await render(null);
    await expect.element(screen.getByText("That member no longer exists.")).toBeVisible();
  });

  it("a member on no team says so, with Add to teams", async () => {
    const screen = await render(detailOf([], ["Cut"]));
    await expect.element(screen.getByText("Not on a team yet")).toBeVisible();
    await expect
      .element(screen.getByText("A member with no team has nothing to do."))
      .toBeVisible();
  });

  it("lists the member's teams as links, and Remove takes the member off one, then re-reads", async () => {
    const calls: Array<string> = [];
    let changed = 0;
    const screen = await render(detailOf(["Cut", "Sew"]), calls, {
      onChanged: async () => {
        changed += 1;
      },
    });
    await expect
      .element(screen.getByRole("link", { name: "Cut" }))
      .toHaveAttribute("href", "/app/teams/team-Cut");
    await screen.getByRole("button", { name: "Remove" }).first().click();
    await expect.poll(() => calls).toStrictEqual(["SetTeamMember team-Cut mem-1 false"]);
    await expect.poll(() => changed).toBe(1);
  });

  it("Add to teams adds the ticked teams, then re-reads", async () => {
    const calls: Array<string> = [];
    let changed = 0;
    const screen = await render(detailOf([], ["Cut", "Sew"]), calls, {
      onChanged: async () => {
        changed += 1;
      },
    });
    await screen.getByRole("button", { name: "Add to teams" }).last().click();
    await screen.getByRole("checkbox", { name: "Sew" }).click();
    await screen.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => calls).toStrictEqual(["AddMemberTeams team-Sew"]);
    await expect.poll(() => changed).toBe(1);
  });

  it("Delete member deletes by email, toasts Member deleted and leaves", async () => {
    const calls: Array<string> = [];
    let deleted = 0;
    const screen = await render(detailOf(["Cut"]), calls, {
      onDeleted: async () => {
        deleted += 1;
      },
    });
    // The modal's opener is in the title bar, which a narrow test page folds away and the admin
    // hoists; its primary button is pressed directly.
    const modal = screen.container.querySelector("s-modal#delete-member");
    const primary = modal?.querySelector<HTMLElement>('s-button[slot="primary-action"]');
    primary?.click();
    await expect.poll(() => calls).toStrictEqual(["DeleteMember m1@m.com"]);
    await expect.poll(() => toasts).toStrictEqual(["Member deleted"]);
    expect(deleted).toBe(1);
  });
});
