import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

import {
  memberHeaders,
  merchantHeaders,
  openAgentSocket,
} from "./agent-socket";
import {
  emailOf,
  resetMemberTables,
  run,
  seedShop,
  shopOf,
  teamNameOf,
} from "./member-fixtures";

/**
 * The object's half of the connection-identity contract, exercised without the
 * Worker gate: these tests forward the `x-baton-*` headers themselves, which is
 * precisely what the gate does and what a hostile client cannot do (a browser
 * cannot set headers on a WebSocket upgrade, and the gate rebuilds the request
 * rather than copying the inbound headers).
 *
 * Every shop name is unique per test for the same reason the workflow tests use
 * unique names: a Durable Object keeps its state across tests in one worker.
 */
const connectionsOf = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
    [...instance.getConnections()].map((connection) => ({
      state: connection.state,
      tags: [...connection.tags],
    })),
  );

describe("ShopAgent connection identity", () => {
  it("stores a merchant identity and tags the connection", async () => {
    const shop = "conn-merchant.myshopify.com";
    const socket = await openAgentSocket(shop, merchantHeaders());
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    const connections = await connectionsOf(shop);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.state).toEqual({
      role: "merchant",
      subscription: null,
    });
    expect(connections[0]?.tags).toContain("merchant");
    socket.close();
  });

  it("stores a member identity, its teams, and the revocation tag", async () => {
    const shop = "conn-member.myshopify.com";
    const socket = await openAgentSocket(
      shop,
      memberHeaders({
        memberId: "member-1",
        memberEmail: "Maker@Example.com",
        teamIds: ["team-a", "team-b"],
      }),
    );
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    const connections = await connectionsOf(shop);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.state).toEqual({
      role: "member",
      memberId: "member-1",
      // Normalized by `Domain.Email` on decode, so the header's casing cannot
      // produce an identity that compares unequal to the D1 row.
      memberEmail: "maker@example.com",
      teamIds: ["team-a", "team-b"],
      subscription: null,
    });
    expect(connections[0]?.tags).toContain("member");
    expect(connections[0]?.tags).toContain("member:member-1");
    socket.close();
  });

  it("accepts a member with no teams", async () => {
    const shop = "conn-member-noteams.myshopify.com";
    const socket = await openAgentSocket(
      shop,
      memberHeaders({
        memberId: "member-2",
        memberEmail: "new@example.com",
        teamIds: [],
      }),
    );
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    const connections = await connectionsOf(shop);
    expect(connections[0]?.state).toMatchObject({
      role: "member",
      teamIds: [],
    });
    socket.close();
  });

  for (const [label, headers] of [
    ["no role header at all", {}],
    ["an unknown role", { [Domain.CONNECTION_ROLE_HEADER]: "operator" }],
    [
      "a member role with no member id",
      {
        [Domain.CONNECTION_ROLE_HEADER]: "member",
        [Domain.CONNECTION_MEMBER_EMAIL_HEADER]: "maker@example.com",
      },
    ],
    [
      "a member role with no email",
      {
        [Domain.CONNECTION_ROLE_HEADER]: "member",
        [Domain.CONNECTION_MEMBER_ID_HEADER]: "member-3",
      },
    ],
  ] as const) {
    it(`closes ${label} with ${String(Domain.CONNECTION_CLOSE_FORBIDDEN)}`, async () => {
      const shop = `conn-bad-${label.replaceAll(/\W+/gu, "-")}.myshopify.com`;
      const socket = await openAgentSocket(shop, { ...headers });
      const { code } = await socket.waitForClose();
      expect(code).toBe(Domain.CONNECTION_CLOSE_FORBIDDEN);
    });
  }

  /**
   * Revocation, the object's half. A membership change cannot reach into a
   * connection and edit the snapshot it was given at connect, so the answer is
   * to close it and let the reconnect ask the gate again — which is what
   * `Domain.CONNECTION_CLOSE_REVOKED` tells the client happened.
   */
  it("revokes only the named member's connections", async () => {
    const shop = "conn-revoke.myshopify.com";
    const revoked = await openAgentSocket(
      shop,
      memberHeaders({
        memberId: "member-revoked",
        memberEmail: "a@example.com",
        teamIds: ["team-a"],
      }),
    );
    const untouched = await openAgentSocket(
      shop,
      memberHeaders({
        memberId: "member-kept",
        memberEmail: "b@example.com",
        teamIds: ["team-a"],
      }),
    );
    await untouched.waitForMessage((data) =>
      data.includes("cf_agent_identity"),
    );
    await env.SHOP_AGENT.getByName(shop).revokeMemberConnections({
      memberIds: ["member-revoked"],
    });
    const { code } = await revoked.waitForClose();
    expect(code).toBe(Domain.CONNECTION_CLOSE_REVOKED);
    await expect(untouched.waitForClose(200)).rejects.toThrow(
      "socket stayed open",
    );
    untouched.close();
  });

  /**
   * The subscription half: a lapse invalidates every connection on the shop,
   * merchant and member, since the gate refuses both once the plan is gone.
   */
  it("revokes every connection on the shop for a lapse", async () => {
    const shop = "conn-lapse.myshopify.com";
    const merchant = await openAgentSocket(shop, merchantHeaders());
    const member = await openAgentSocket(
      shop,
      memberHeaders({
        memberId: "member-lapsed",
        memberEmail: "a@example.com",
        teamIds: ["team-a"],
      }),
    );
    await member.waitForMessage((data) => data.includes("cf_agent_identity"));
    await env.SHOP_AGENT.getByName(shop).revokeAllConnections();
    const merchantClose = await merchant.waitForClose();
    const memberClose = await member.waitForClose();
    expect(merchantClose.code).toBe(Domain.CONNECTION_CLOSE_REVOKED);
    expect(memberClose.code).toBe(Domain.CONNECTION_CLOSE_REVOKED);
  });
});

/**
 * Deleting a team is the case revocation exists for: the D1 row and its
 * `TeamMember` edges go, and every member who was on it is holding a socket
 * whose `teamIds` still name it. The roster has to be read before the delete
 * cascades it away, which is why `Repository.deleteTeam` returns it.
 */
describe("ShopAgent team delete revocation", () => {
  afterEach(async () => {
    await resetMemberTables();
  });

  it("closes the sockets of everyone who was on the deleted team", async () => {
    const shop = shopOf("conn-team-delete.myshopify.com");
    const { teamId, memberId } = await Effect.runPromise(
      run(
        Effect.gen(function* () {
          yield* seedShop(shop);
          const repository = yield* Repository;
          const team = yield* repository.createTeam({
            shop,
            name: teamNameOf("Engraving"),
          });
          const email = emailOf("maker@example.com");
          yield* repository.addMember({ shop, email });
          const access = yield* repository.findMemberAccess({ shop, email });
          const memberId = Option.isNone(access)
            ? yield* Effect.die("member missing right after addMember")
            : access.value.memberId;
          yield* repository.setMemberTeams({
            shop,
            memberId,
            teamIds: [team.id],
          });
          return { teamId: team.id, memberId };
        }),
      ),
    );
    const socket = await openAgentSocket(
      shop,
      memberHeaders({
        memberId,
        memberEmail: "maker@example.com",
        teamIds: [teamId],
      }),
    );
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    await env.SHOP_AGENT.getByName(shop).deleteTeam({ teamId });
    const { code } = await socket.waitForClose();
    expect(code).toBe(Domain.CONNECTION_CLOSE_REVOKED);
  });
});
