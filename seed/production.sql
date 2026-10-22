-- Bootstrap the production administrator after Better Auth migrations. Repeated deploys preserve
-- an existing user instead of replacing account details or resetting access.
insert or ignore into "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) values ('user-admin', 'Admin', 'support@mw10013.com', 1, 'admin', 0, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
