import * as Effect from "effect/Effect";
import { installAppBridge } from "../../app-bridge.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Page } from "../../../../src/backend/membership-repository.ts";
import { MemberCeilingError } from "../../../../src/contract/members.ts";
import { Email } from "../../../../src/domain/platform.ts";
import { type ListSearch, Member, MemberSummary } from "../../../../src/domain/shop-work.ts";
import MembersIndexPage from "../../../../src/web/components/MembersIndexPage.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const email = Schema.decodeUnknownSync(Email);

const summary = (n: number, teamCount: number) =>
  Schema.decodeUnknownSync(MemberSummary)({
    id: `mem-${n}`,
    shop: SEED_SHOP,
    email: `m${n}@m.com`,
    createdAt: 0,
    teamCount,
  });

const pageOf = (rows: ReadonlyArray<MemberSummary>): Page<MemberSummary, Email> => ({
  rows,
  nextCursor: null,
  matches: null,
});

/** App Bridge's `shopify` global, stubbed: hidden modals and toasts are recorded. */
let hidden: Array<string> = [];
beforeEach(() => {
  hidden = [];
  installAppBridge({ hide: (id) => hidden.push(id) });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

/** What the in-memory actor's Add member answers: the new member, or the ceiling. */
const render = (
  page: Page<MemberSummary, Email>,
  options: {
    q?: ListSearch | null;
    added?: Effect.Effect<Member, MemberCeilingError>;
    onAdded?: (member: Member) => Promise<void>;
  } = {},
) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <MembersIndexPage
        page={page}
        q={options.q ?? null}
        after={null}
        memberLink={(id) => ({
          href: `/app/members/${id}`,
          onClick: (event) => event.preventDefault(),
        })}
        onSearch={() => {}}
        onNextPage={() => {}}
        onPreviousPage={() => {}}
        onAdded={options.onAdded ?? (async () => {})}
      />
    </ShopSocket>,
    shopTestRegistry({
      MerchantAddMember: ({ email }) =>
        options.added ??
        Effect.succeed(
          Schema.decodeUnknownSync(Member)({ id: "mem-new", shop: SEED_SHOP, email, createdAt: 0 }),
        ),
    }),
  );

describe("MembersIndexPage", () => {
  it("lists each member's email as a link to their page, and No teams for a teamless one", async () => {
    const screen = await render(pageOf([summary(1, 2), summary(2, 0)]));
    await expect
      .element(screen.getByRole("link", { name: "m1@m.com" }))
      .toHaveAttribute("href", "/app/members/mem-1");
    await expect.element(screen.getByText("2", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("No teams")).toBeVisible();
  });

  it("a shop with no members is the empty state, with Add member", async () => {
    const screen = await render(pageOf([]));
    await expect.element(screen.getByText("No members yet")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add member" }).last()).toBeVisible();
  });

  it("a search that matches nobody says so, with Clear search", async () => {
    const screen = await render(pageOf([]), { q: "zed" as ListSearch });
    await expect.element(screen.getByText("No members match.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Clear search" })).toBeVisible();
  });

  it("Add member adds the trimmed, lowercased email, hides the modal and hands the member on", async () => {
    const added: Array<Member> = [];
    const screen = await render(pageOf([]), {
      onAdded: async (member) => {
        added.push(member);
      },
    });
    await screen.getByRole("button", { name: "Add member" }).last().click();
    await screen.getByRole("textbox", { name: "Email" }).fill("  New@M.com ");
    await screen.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => added.map((member) => member.email)).toStrictEqual(["new@m.com"]);
    expect(hidden).toStrictEqual(["add-member"]);
  });

  it("an email past 254 characters is refused on Add with the field's own error", async () => {
    const screen = await render(pageOf([]));
    await screen.getByRole("button", { name: "Add member" }).last().click();
    await screen
      .getByRole("textbox", { name: "Email" })
      .fill(`${"a".repeat(255 - "@m.com".length)}@m.com`);
    await screen.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(screen.getByText("Up to 254 characters")).toBeVisible();
  });

  it("the ceiling's refusal is the banner, in legacy's words", async () => {
    // The empty state's twin: outside the admin, the title bar's copy is in `s-page`'s actions,
    // which a narrow test page folds away; in the admin App Bridge hoists it.
    const screen = await render(pageOf([]), {
      added: Effect.fail(new MemberCeilingError({ shop: SEED_SHOP, limit: 50 })),
    });
    await screen.getByRole("button", { name: "Add member" }).last().click();
    await screen.getByRole("textbox", { name: "Email" }).fill(email("over@m.com"));
    await screen.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(screen.getByText("A shop can have 50 members.")).toBeVisible();
  });
});
