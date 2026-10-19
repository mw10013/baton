# Implementer brief (template)

Fill in the `<…>` parts and pass the whole text as the prompt of the one implementation subagent (Agent tool, model opus). The subagent has no other context.

---

You implement `<plan path>` in this repository, on `main`, yourself: do not start subagents or threads.

**Read first:** `AGENTS.md`; `<plan path>` whole; `<research path>` and the sections the plan cites; `<any runbooks the plan names>`. Legacy is under `refs/baton-legacy/` (read-only).

**Work:** step by step, each step ending green, recording deviations, issues and command results in §7 as you go (short, dated, step-tagged). Do not rewrite the steps.

**Tests:** per step, `vp check --fix` and `vp test <files>` for the tests the step touches. Run an e2e spec only when the step changes what it exercises; never the full e2e suite (the reviewer runs it once). The full `vp test` once at the end. Never re-run through a failure you already understand: record it and move on.

**Rules:**

- Commit on `main` at the end of each green step, staging paths explicitly, ending the message with `Co-Authored-By: <model attribution>`. Never push.
- Never run `cloud:reset`, `alchemy deploy` or `vp run deploy:staging`. Never touch the `staging` stage.
- Never edit `refs/`. Never reference plans or research in code or JSDoc.
- Do not ask the user questions. Decide routine things and record them in §7.
- When a step needs a person (a login, a store auth, a dashboard step), write the exact steps and what they unblock under §7 "Human steps requested", then stop.

**Stop** at a human step or when §6 "Done when" holds. Your final message lists your commits, test results, and what needs a decision, with a recommendation for each.
