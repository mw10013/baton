-- The test environment's one seed: the admin (a@a.com, a Better Auth user with the role admin)
-- and the integration tests' fake shops, members and team, which only the integration tests read
-- (e2e runs on the real e2e store, seeded by `seed/e2e.sql`). The `Seed` Action runs it after
-- Better Auth's migration, so it may fill Baton's tables and Better Auth's alike. Rows are
-- idempotent (INSERT OR IGNORE) and shaped as Better Auth stores them: ISO text dates, 0/1
-- booleans. Tokens are fakes shaped like Shopify's; shop times are epoch ms, 2100-01-01 for "never
-- expires". The admin's timestamp is fixed so the file's content, which `Seed` hashes, stays
-- stable.
INSERT OR IGNORE INTO ShopSession (shop, shopGid, shopActorId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt, planHandle, planHandleExpiresAt, planBoundaryAt) VALUES
  ('seed-shop.myshopify.com', 'gid://shopify/Shop/1', 'seed-shop.myshopify.com', 'read_orders,write_orders', 4102444800000, 'shpat_fake_seed_shop', 'shprt_fake_seed_shop', 4102444800000, 'baton-pro', 4102444800000, NULL),
  ('other-shop.myshopify.com', 'gid://shopify/Shop/2', 'other-shop.myshopify.com', 'read_orders,write_orders', 4102444800000, 'shpat_fake_other_shop', 'shprt_fake_other_shop', 4102444800000, 'baton-pro', 4102444800000, NULL);

INSERT OR IGNORE INTO Member (id, shop, email, createdAt) VALUES
  ('mem-1', 'seed-shop.myshopify.com', 'm1@m.com', 1760227200000),
  ('mem-2', 'seed-shop.myshopify.com', 'm2@m.com', 1760227200000),
  ('mem-3', 'other-shop.myshopify.com', 'm1@m.com', 1760227200000);

INSERT OR IGNORE INTO Team (id, shop, name, createdAt) VALUES
  ('team-1', 'seed-shop.myshopify.com', 'ops', 1760227200000);

INSERT OR IGNORE INTO TeamMember (teamId, memberId, createdAt) VALUES
  ('team-1', 'mem-1', 1760227200000);

INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'a@a.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
