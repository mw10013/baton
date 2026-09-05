create table if not exists ShopSession (
  shop text primary key,
  shopGid text not null,
  shopAgentId text not null unique,
  scope text,
  accessTokenExpiresAt integer,
  accessToken text,
  refreshToken text,
  refreshTokenExpiresAt integer,
  planHandle text,
  planHandleExpiresAt integer
);

-- archivedAt (null = active) is the merchant-facing delete: run history in the
-- ShopAgent's SQLite references Member.id (WorkflowRunStep.startedBy /
-- completedBy, the block flag's actor) with no FK, so nothing hard-deletes a
-- member that may have worked. Uniqueness spans active and archived rows so
-- re-adding an archived email restores the same id and history re-attaches.
create table if not exists Member (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  email text not null check (email = lower(trim(email))),
  createdAt text not null,
  archivedAt text,
  unique (shop, email)
);

-- Teams are shop-scoped groupings of Member rows: identity, not workflow data,
-- so they live in D1 beside Member rather than in the ShopAgent's SQLite. That
-- buys real referential integrity in both directions (archiving a shop or a
-- member cleans up its edges) at the cost of a hard FK from Durable Object rows
-- to a team, which is deliberately left as an opaque id.
--
-- archivedAt (null = active) is the merchant-facing delete: a team that ever
-- owned work must stay resolvable by name forever, so nothing hard-deletes one.
-- Uniqueness spans active and archived rows for the same reason -- reusing an
-- archived team's name would make historical records ambiguous.
create table if not exists Team (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  name text not null check (name = trim(name) and length(name) > 0),
  createdAt text not null,
  archivedAt text
);

create unique index if not exists Team_shop_name_uidx on Team (shop, name collate nocase);

-- Edges point at Member.id, not at an email: a memberId belongs to exactly one
-- shop, so "a team never crosses shops" holds by construction and both cascades
-- (member removed, team removed) come free.
create table if not exists TeamMember (
  teamId text not null references Team (id) on delete cascade,
  memberId text not null references Member (id) on delete cascade,
  createdAt text not null,
  primary key (teamId, memberId)
);

-- Serves the member-area guard's memberId -> teamIds join; the primary key
-- already covers the teamId -> members direction.
create index if not exists TeamMember_memberId_idx on TeamMember (memberId);

-- better-auth 1.7.2 core + admin tables (magic-link auth, no organization
-- plugin — membership is the app-owned Member table above). Hand-written
-- against the runtime schema definitions (getAuthTables) rather than
-- @better-auth/cli output; the auth-schema integration test diffs this against
-- better-auth's expectations structurally on every run (getSchema-based; see
-- test/integration/auth.test.ts). Dates are ISO-8601 text (better-auth writes
-- toISOString()); booleans are 0/1. UserRole is an FK-backed enum: better-auth
-- never reads it, it exists so D1 (no transactions, no check-constraint
-- migrations without a table rebuild) cannot accumulate silent junk values.
create table if not exists UserRole (userRoleId text primary key);

insert or ignore into UserRole (userRoleId) values ('user'), ('admin');

create table if not exists User (
  id text primary key,
  name text not null,
  email text not null unique,
  emailVerified integer not null default 0,
  image text,
  createdAt text not null,
  updatedAt text not null,
  role text not null default 'user' references UserRole (userRoleId),
  banned integer not null default 0,
  banReason text,
  banExpires text
);

create table if not exists Session (
  id text primary key,
  expiresAt text not null,
  token text not null unique,
  createdAt text not null,
  updatedAt text not null,
  ipAddress text,
  userAgent text,
  userId text not null references User (id) on delete cascade,
  impersonatedBy text references User (id)
);

create index if not exists Session_userId_idx on Session (userId);

create index if not exists Session_expiresAt_idx on Session (expiresAt);

create table if not exists Account (
  id text primary key,
  issuer text not null,
  accountId text not null,
  providerId text not null,
  userId text not null references User (id) on delete cascade,
  accessToken text,
  refreshToken text,
  idToken text,
  accessTokenExpiresAt text,
  refreshTokenExpiresAt text,
  scope text,
  password text,
  createdAt text not null,
  updatedAt text not null
);

create index if not exists Account_userId_idx on Account (userId);

-- Name and shape must match better-auth's resolved table-level index exactly:
-- the drift test diffs indexes by name (Account_issuer_accountId_uidx).
create unique index if not exists Account_issuer_accountId_uidx on Account (issuer, accountId);

create table if not exists Verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expiresAt text not null,
  createdAt text not null,
  updatedAt text not null
);

create index if not exists Verification_identifier_idx on Verification (identifier);
