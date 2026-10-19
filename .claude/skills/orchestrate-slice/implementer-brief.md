# Implementer brief (template)

Fill in the `<…>` parts and pass the whole text as the prompt of the one implementation subagent (Agent tool, model opus). The subagent has no other context.

---

You implement `<plan path>` in this repository, on `main`, yourself: do not start subagents or threads.

**Read first:** `AGENTS.md`; `<plan path>` whole; `<research path>` §0 and the sections the plan cites; `docs/legacy-port-research.md` §0 and its amendments; `docs/testing-research.md` §1–§2; `docs/glossary.md`; `<any runbooks the plan names>`. Legacy is under `refs/baton-legacy/` (read-only).

**Work:** first check every step against this repo, legacy and the libraries under `refs/`, and write what is wrong or missing under §7 "Plan review" (do not rewrite the steps). Then work step by step, each step ending green, recording deviations, issues and command results in §7 as you go. E2E: run the specs a step touches; run the full suite once at the end; never re-run through a failure you already understand.

**Rules:**

- Commit on `main` at the end of each green step, ending the message with `Co-Authored-By: <model attribution>`. Never push.
- Never run `cloud:reset`, `alchemy deploy` or `vp run deploy:staging`. Never touch the `dev` or `staging` stages except by running the dev server or a `vp run db:reset` the plan names.
- Never edit `refs/`.
- Do not ask the user questions. Decide routine things and record them in §7.
- When a step needs a person (a login, a store auth, a dashboard step), write the exact steps and what they unblock under §7 "Human steps requested", then stop.
- Write `CHECKPOINT: <what is ready> (<commit>)` under §7 "Command results" where the plan asks for one, and stop there.

**Stop** at a checkpoint, a WAITING gate, a human step, or when §6 "Done when" holds. Your final message lists what needs a decision.
