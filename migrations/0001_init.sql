-- Baton's D1 schema: shops and who may work in them. Work itself (orders, workflows, runs) lives
-- in each shop's ShopActor; identity lives here, and the actor points into it by id, never back.
-- Better Auth's tables are not here: @alchemy.run/better-auth creates them.
--
-- While prototyping this is the only migration and is edited in place; a schema change is applied
-- by resetting the database (`vp run db:reset`, `vp run cloud:reset`), never by a second file.
--
-- Times are epoch-ms integers.

-- shopActorId names the shop's actor and is set once: an upsert never rewrites it.
-- refreshLeaseUntil (epoch ms) serializes refresh-token grants for one shop; it is not indexed.
create table if not exists ShopSession (
  shop text primary key,
  shopGid text not null,
  shopActorId text not null unique,
  scope text,
  accessTokenExpiresAt integer,
  accessToken text,
  refreshToken text,
  refreshTokenExpiresAt integer,
  refreshLeaseUntil integer,
  planHandle text,
  planHandleExpiresAt integer,
  planBoundaryAt integer
);

-- No soft delete: uniqueness is among existing rows only, so re-adding an email mints a new id.
-- Every read of a shop's members is in email order, which the unique (shop, email) index
-- answers. Reads by email alone (the sign-in gate, revocation) have their own index below.
create table if not exists Member (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  email text not null check (email = lower(trim(email)) and length(email) <= 254),
  createdAt integer not null,
  unique (shop, email)
);

-- An email's shops, read on every sign-in and revocation. It covers the read, so D1 reads one
-- index entry per shop the email belongs to instead of every Member row; the price is one more
-- row written per Member insert or delete, which is rare next to sign-ins.
create index if not exists Member_email_shop_idx on Member (email, shop);

-- Teams group a shop's members. They are identity, not work, so they live here beside Member,
-- where foreign keys clean up after a deleted shop or member. A run task in the actor points at
-- a team by an opaque id that no foreign key can reach; deleting a team clears those pointers
-- after the row goes, so a task reads as unassigned in between.
create table if not exists Team (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  name text not null check (name = trim(name) and length(name) > 0),
  createdAt integer not null,
  unique (shop, name)
);

-- Edges point at Member.id, not an email, so removing a member or a team removes its edges.
-- Nothing here checks that the team and the member belong to the same shop; the write that adds
-- an edge must.
create table if not exists TeamMember (
  teamId text not null references Team (id) on delete cascade,
  memberId text not null references Member (id) on delete cascade,
  createdAt integer not null,
  primary key (teamId, memberId)
);

-- A member's teams, read when their socket is admitted; the primary key already serves a team's
-- members.
create index if not exists TeamMember_memberId_idx on TeamMember (memberId);
