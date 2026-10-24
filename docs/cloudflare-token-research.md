# One Cloudflare token for the laptop: research

Status: research, 2026-10-24. Not acted on. The user takes it up on 2026-10-25. Direction already given: keep one token, widen its permissions, and let the voice script use the same token. The questions are in §5.

## 0. Summary

Every `cf` command, `vp run cloud:reset` included, should just work from any shell, for a person or an agent, with no `env -u` and no extra login step. Today they don't, because `~/.zshrc` exports a `CLOUDFLARE_API_TOKEN` that was made for Workers AI (screencast voice) and lacks the Workers Builds permission. Both `cf` and Alchemy use that variable ahead of their own logins, so the narrow token wins wherever it falls short.

Recommendation: widen that one token to cover everything this laptop does on Cloudflare (§3), roll it while doing so, keep exporting it as `CLOUDFLARE_API_TOKEN`, and then remove every workaround from the skills, runbooks, scripts and memory (§4).

## 1. Who talks to Cloudflare from the laptop

| Tool                                         | Used for                                                     | Credentials it reads, first match wins                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf`                                         | build triggers, deployments, logs (`cf o11y`), `cloud:reset` | `CLOUDFLARE_API_TOKEN`, then its own OAuth login (`cf auth login`)                                                                                                                                                        |
| Alchemy (`alchemy deploy`, `destroy`, `dev`) | deploying and destroying the stacks                          | `CLOUDFLARE_API_TOKEN` (or key and email), then its profile in `~/.alchemy`. Source: `presentEnvironment` in Alchemy's `src/Auth/AuthProvider.ts`: "Environment credentials take precedence over any profile, CI or not." |
| `scripts/lib/tts.ts` (`speechToken`)         | screencast and listing narration on Workers AI               | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only                                                                                                                                                                   |

Workers Builds itself (the deploy on push to `main` and `production`) runs in Cloudflare with its own token, "Workers Builds - 2026-05-31 17:29", chosen in the dashboard. It never reads the laptop's token and is out of scope.

## 2. What goes wrong today

- `~/.zshrc` exports `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The export was commented out on 2026-10-14 so that `cf` would use its OAuth login, and came back later for the voice script.
- With the variable set, `cf builds triggers list` answers "Invalid token". `cloud:reset` calls it, so `vp run cloud:reset --stage staging --confirm staging` fails until run as `env -u CLOUDFLARE_API_TOKEN vp run cloud:reset …`.
- `cf workers deployments list` and Alchemy deploys work with the same token, so the failure appears only on some commands. That is what made it confusing: nothing says which credential a command used.
- Seen on 2026-10-24: Alchemy `deploy` and `destroy` of production ran on the env token without trouble.
- The token sits in plain text in `~/.zshrc`, and it was printed in an agent's tool output on 2026-10-24.

## 3. The one token

Create it under My Profile → API Tokens (or roll the existing one and edit it), scoped to the one account `87997fc2724b0127effb8e4524989975`. It needs the union of:

| Needed by                                                   | Permission (account level unless noted)                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Alchemy deploy and destroy                                  | whatever the current token already has (it deploys today). Keep all of it. |
| `cf builds …`, `cloud:reset` (creates and deletes triggers) | Workers Builds Configuration: Edit                                         |
| `cf workers deployments list`                               | Workers Scripts: Read (already covered by deploy's Edit)                   |
| `cf o11y telemetry query` (staging and production logs)     | Workers Observability: Read. Not yet checked against the current token.    |
| Voice (`tts.ts`)                                            | Workers AI: Read                                                           |
| Alchemy's account check                                     | Account Settings: Read, Memberships: Read                                  |

Check after the change, from a plain agent shell with no `env -u`:

```bash
cf builds triggers list
```

```bash
vp run cloud:reset --stage staging --confirm staging
```

and one `cf o11y telemetry query` against `baton-backend-staging`, plus one `vp run screencast` voice render if a render is wanted anyway.

Where it lives: keeping `export CLOUDFLARE_API_TOKEN=…` in `~/.zshrc` is the simplest and is what agents' shells already load. A tidier option is to keep the value in the macOS Keychain and export it from `~/.zshrc` with `security find-generic-password -w -s cloudflare-api-token`, so the file holds no secret. Either way, the name stays `CLOUDFLARE_API_TOKEN`, so every tool finds it without a wrapper.

With a sufficient env token, `cf auth login` and the Alchemy profile become unused fallbacks. They can stay.

## 4. What changes once the token covers everything

The goal: an agent runs `cf …`, `vp run cloud:reset` or a deploy as written, and it works. Every workaround and caveat goes.

- `scripts/cloud-reset.ts`: no change needed. Confirm it runs as is.
- `scripts/lib/tts.ts`, `scripts/tts.ts`, `scripts/screencast.ts`: already read `CLOUDFLARE_API_TOKEN`. No change, except any JSDoc that calls it a Workers AI token.
- `docs/production-release-runbook.md`: check its `cf` steps for any login or token caveat, and remove it.
- `AGENTS.md` (Logs): stays as is. Consider one line saying `cf` needs no setup, only if agents keep stumbling.
- `.claude/skills/verify-baton/SKILL.md` and the exploratory-test workflow: the 2026-10-24 production test lost time on log queries and on finding what was live. Fold in the fixes from that review (sign-in, browser sessions, logs, build status) so the skill gives the exact commands, and those commands just work.
- Agent memory: rewrite the "cf auth" note (no `env -u`), and drop the note telling agents to eval the two exports from `~/.zshrc` for voice.

## 5. Questions

1. Widen the existing token (roll its value while editing) or create a new one and delete the old? Recommendation: roll and edit the existing one. One fewer token to track, and the roll retires the value that was printed.
2. Keep the value in `~/.zshrc`, or in the Keychain read from `~/.zshrc`? Recommendation: the Keychain. Same variable name, no secret in a dotfile.
3. Log out of `cf auth` and the Alchemy profile so there is only one credential on the laptop? Recommendation: no. They are unused while the env token is set and cost nothing.
