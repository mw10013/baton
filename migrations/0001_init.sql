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

create table if not exists Member (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  email text not null check (email = lower(trim(email))),
  createdAt text not null,
  unique (shop, email)
);
