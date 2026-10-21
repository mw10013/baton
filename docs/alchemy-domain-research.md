# Alchemy Domain: research

Status: research, written 2026-10-19. Not settled. The question: could `@alchemy.run/domain`, Alchemy's new domain-driven design framework, serve Baton, and if not, which of its ideas are worth taking without it.

Sources: the docs at https://main.alchemy.run/domain/ (overview, model, aggregate, view, projection, policy, saga, external system, api, sessions, unique values, Cloudflare hosting), the bank example (`examples/cloudflare-domain`), and the Cloudflare host (`packages/cloudflare/src/Domain/index.ts`), all read from Alchemy `main` at 2f226d99 (2026-10-19). `refs/alchemy` is beta.81 and predates Domain, so none of it is in `refs/`.

---

## 0. Questions

| Q   | Question                                   | Recommendation                                                                                                                                                           |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Adopt Domain for Baton's Backend?          | No. It replaces the actor design rather than adding to it (§3), and it is unreleased (§1).                                                                               |
| Q2  | When to upgrade Alchemy?                   | Once, when the release with the package split (§1) ships, not tracking `main`. Re-check both patches then; drop any upstream fixed.                                      |
| Q3  | Watch Domain?                              | Yes. Revisit after a few releases, if it gains users beyond its author, or if Baton grows a context Baton itself decides (not Shopify) with rules spanning many records. |
| Q4  | Which ideas to take without the framework? | §5. First candidate: command ids for verbs and syncs that can repeat (§5.2). Named events (§5.3) only if a second consumer of "what happened" appears.                   |

---

## 1. Where it stands

- Domain merged to Alchemy `main` on 2026-10-15 (#2176). No release carries it: the latest on npm is `2.0.0-beta.83` (2026-10-12), and `@alchemy.run/domain` is not on npm.
- On 2026-10-19 `main` also moved Cloudflare, Stripe, Domain and others into their own packages (`@alchemy.run/cloudflare`, …), a breaking change to every Alchemy import.
- Baton is on `2.0.0-beta.81` with two patches (`patches/alchemy@2.0.0-beta.81.patch`, about 105 lines on `LocalWorkerProvider` and `Platform`; `patches/@alchemy.run__cloudflare-runtime@2.0.0-beta.81.patch`, about 30 lines on `WorkerProxy`).
- Getting Domain means running unreleased `main` or waiting for the next release, which will carry the package split too. Upgrading to beta.83 alone is cheap but brings no Domain.
- The docs pair the browser side with foldkit. An Api has a typed Effect client usable without foldkit, so this is not a blocker, but foldkit is the path the docs walk.

## 2. What Domain is

A model is one bounded context. Its parts, in the order a command meets them:

| Part            | What it does                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command         | A request to change one instance, with its input, the events it may record, its rejections and its reply, all as Schema.                                            |
| Aggregate       | The decider. Many instances, one per id, each handling one command at a time. `decide(state, command)` returns events or a rejection; `evolve(state, event)` folds. |
| Event           | The record. Appended per instance with a sequence number; state is derived from it (event sourcing).                                                                |
| View            | A read model per key, folded from events, stored and served by the platform: `get`, `list`, `watch`, `events`, with `validate` per read.                            |
| Projection      | Writes events into a store you own (D1, a search index), batched, replayable, never sends commands.                                                                 |
| Policy          | A standing business rule: on an event, decide and send commands or call outside systems. At least once, never replays.                                              |
| Saga            | A multi-step process across aggregates, an Effect workflow with stored steps and compensations.                                                                     |
| External system | The calls the model makes to an outside service, declared as Schema, implemented by a Layer.                                                                        |
| Api             | What one kind of client may reach: chosen commands and reads. Served from a Worker over HTTP, live reads over WebSockets.                                           |
| Story           | A test: given these events, when this command, then these events, with outside calls resolved by the test.                                                          |

Guarantees: a command's events, new state, reply and deliveries commit in one write. Every consumer gets every event at least once, in order per source, and drops repeats. A command's receipt is stored under its command id, so a retried command returns the first receipt instead of deciding again. A reader passes a receipt as `atLeast` to wait until a view has applied its own write.

The same model runs in memory (`Domain.InMemory`) for tests and on Durable Objects (`DomainCloudflare.DurableObjects`) in production.

## 3. Why not Baton

### 3.1 It replaces the actor

The Backend's design is one **actor** per **shop** that owns the shop's D1 reads and writes, the Admin API and the **Workflow**, with writes as **procedures** over one socket per tab, and **publish** telling every **connection** to re-read. That design is settled. Domain is a different backend: commands to aggregates, views it serves itself, its own Api and live-read protocol. There is no shape where Domain runs inside the actor; adopting it means re-porting the Backend we just finished porting.

### 3.2 Many Durable Objects, many hops

On Cloudflare every aggregate instance, view key, policy key, projection key, stream key and saga run is its own Durable Object, declared by the host while the Worker starts. In the bank, one account is an account object, a summary object, a statement object, a ledger object, a daily-outflow object and more.

Idle objects hibernate, so the count costs little. The hops are what costs. Inside the host, each object keeps a durable outbox in its storage, written in the commit's transaction, drained right after it and again by a scheduled callback 10 seconds later if the object died first. So one command is:

1. the Worker calls the aggregate's object, which decides and commits events plus outbox rows;
2. the outbox calls each view, projection and policy object for those events;
3. a policy may send further commands, each starting again at 1.

One click can wake three to six objects in sequence, and every view trails the write it reflects. Today a verb is one hop, consistent within the shop, and the next read sees it.

### 3.3 State lives in object storage, not D1

Aggregate and view state is in each object's own storage. Anything that reads across records, such as the orders index with its **filters**, **counts** and **search**, the **admin** console's shop list, or **reconcile all**, has no SQL to run against it; each needs a projection written back into D1, which is the store Baton reads from now.

### 3.4 Shopify decides orders

Domain is strongest where the app makes the decisions. For **orders**, Shopify does: a **webhook** or **sync** reports a fact. In Domain terms those are commands that never reject (the bank's `RecordSettlement`), which is where the framework adds least. The decisions Baton makes are in **shop work** (verbs on runs and tasks, workflow edits, **reconcile**), and those already live as pure rules (§4).

### 3.5 Maturity

Four days old at the time of writing, one author, unreleased, tied to Alchemy and Cloudflare. The design is careful and its Effect idioms match ours (Schema everywhere, tagged rejections, Layers per implementation), which is reason to watch it, not to take it.

## 4. The DDD Baton already has

Domain-driven design is first a way of modelling; event sourcing is a separate, heavier choice that Domain bundles. Much of the modelling half is in Baton already:

| DDD idea                                                                 | In Baton                                                                                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubiquitous language: one word, one meaning, per context                  | `docs/glossary.md`; each context file's top-of-file vocabulary under `src/domain/`                                                                                               |
| Bounded contexts with an import direction                                | `platform`, `orders`, `shop work`, `billing` in `src/domain/`, mapped at the top of `src/domain/platform.ts`                                                                     |
| Aggregate: the boundary where rules hold together, one command at a time | The shop's actor: one shop, its writes serialized                                                                                                                                |
| Pure decisions, tested as tables                                         | `runActions`, `taskActions`, `reconcileItem`, `workflowIsEligible`, `itemMatches` in `src/domain/shop-work.ts`, one test per table row in `test/unit/domain/run-actions.test.ts` |
| External system behind an interface                                      | The Admin API client as an Effect service, stubbed in tests                                                                                                                      |
| Saga: a long process with stored steps                                   | The orders sync **Workflow**                                                                                                                                                     |
| Idempotent reaction                                                      | **reconcile** and **reconcile all** are idempotent by definition                                                                                                                 |

The aggregate is coarser than Domain would draw it (a whole shop, not one run), which is what makes Baton's lists plain SQL and its writes one hop. That is a deliberate trade, not a missing idea.

## 5. Ideas to take without the framework

### 5.1 `decide` / `evolve` split

Domain separates deciding (may refuse, runs once) from applying (must accept, deterministic). Baton's action matrices already decide purely; applying is SQL in the run repository. Splitting further only pays with event sourcing, which Baton does not want. Nothing to do.

### 5.2 Command ids

Domain stores each command's receipt under its id, so a retry over a flaky socket or a redelivered webhook returns the first result instead of acting twice. Baton's verbs are guarded by state (a done task cannot be done again), and order syncs are idempotent upserts, so most repeats are already harmless. Worth an audit: list each procedure, ask what a repeat does, and add a caller-supplied id only where a repeat is not harmless. None is known; the run note is one field set whole, so a repeat writes the same text.

### 5.3 Named events

Domain records "what happened" as typed events and lets views and policies consume them. Baton's equivalent is publish, which carries no data by design (the **invalidation** is the one message). Named events earn their place only when a second consumer needs to know what happened, such as an audit trail or a notification on run completion. None does today.

### 5.4 Stories as a test style

Given / when / then in the context's words reads well. Baton's table tests already state rows in the glossary's words; a story style would suit multi-step behaviour (a run through every task to done) more than single decisions. Optional.

### 5.5 Read your own write by receipt

Domain's `atLeast: receipt` exists because its views lag. Baton's reads do not lag the actor's own writes, so there is nothing to wait for.

## 6. If we came back to it

The signals that would reopen Q1: Domain released and used beyond its author; a Baton context where Baton decides and the rules span many records (for example scheduling across teams); or a need for a full history of what happened to a run. A first step then would be one bounded context beside the actor, reached through its Api, not a rewrite of shop work.
