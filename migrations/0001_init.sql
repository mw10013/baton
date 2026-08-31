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
