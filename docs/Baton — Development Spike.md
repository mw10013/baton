Baton — Development Spike

Purpose

Build the smallest believable skeleton of an owner-in-Shopify / worker-outside-Shopify workflow. The spike is for capability development and architecture learning. It is not market validation, a V1 specification, or a commitment to build the product.

Spike question

Can we connect a Shopify owner surface to a deliberately tiny external worker surface, authenticate a non-Shopify worker, share one piece of production work between them, and persist the handoff without the architecture becoming unwieldy?

Time box

Roughly 1–2 weeks of focused development. If the skeleton starts requiring substantial product design, stop and simplify it.

What the spike needs to prove

1\. A development Shopify store has a few synthetic made-to-order orders.  
2\. The embedded app can read enough Shopify order data to show a tiny production-job list.  
3\. The owner can invite one external worker by email.  
4\. The worker can sign in to a separate web app using a passwordless email magic link, without a Shopify account.  
5\. The worker can open a permitted test job and mark it Start, Block, or Done.  
6\. The state change is persisted with an actor and timestamp.  
7\. The owner can see the changed state/history inside the embedded Shopify app.

Working assumptions for speed

These are disposable spike assumptions, not product decisions.

\- Shopify remains the commerce system of record.  
\- Baton owns only the tiny amount of workflow state required for the demo.  
\- Cloudflare is the intended infrastructure. The working tenant shape is one SQLite-backed Durable Object per Shopify shop.  
\- Use one development shop and one external worker.  
\- A worker only needs to belong to one shop during the spike. Do not design multi-shop worker accounts.  
\- Do not settle the eventual order-versus-line-item job model. Shape the synthetic test data so the simplest representation works.  
\- Use a fixed minimal state model: Ready, In Progress, Blocked, Done. Do not build configurable stages or a workflow engine.  
\- Use passwordless email magic links for the external worker. Do not design passwords, recovery, MFA, or a general identity system.  
\- Expose only the Shopify fields needed to make the test job understandable. Do not design a general field-mapping or worker-data-permissions system.  
\- Keep Baton state inside Baton. Do not write production state back to Shopify during the spike.

Minimum surfaces

Embedded Shopify app

\- Jobs: show a few synchronized test jobs and their current Baton state.  
\- Job: show enough order/item/customization information to recognize the work plus recent Baton activity.  
\- Worker: invite one worker by email and revoke access if easy.

External worker app

\- Sign in from an email magic link.  
\- My work: show only the test work the worker is allowed to see.  
\- Job: show the production information plus Start, Block, and Done actions.

Shopify synchronization

Keep synchronization deliberately unsophisticated.

\- Read a small set of synthetic orders from the Admin GraphQL API.  
\- Mirror only the minimum production-facing snapshot needed by the spike.  
\- Do not solve order edits, cancellations, refunds, fulfillment changes, historical reconciliation, or every webhook edge case.  
\- A single basic webhook/update path can be added if useful for learning, but comprehensive synchronization is not required for the spike to succeed.

Authentication / authorization boundary

Owner/manager access stays inside the Shopify-authenticated embedded app.

The external worker has a separate Baton identity reached through a passwordless email magic link. The invitation establishes the worker's relationship to the one test shop. Every worker request must resolve back to that shop before reading or changing its Baton data.

Do not build roles, departments, shared stations, fine-grained permissions, account recovery, or multi-shop membership during the spike.

Deliberate non-goals

\- configurable stages or workflow builder  
\- Kanban drag-and-drop  
\- assignments beyond whatever is minimally necessary to make one worker see a test job  
\- Shopify Flow  
\- Shopify write-backs or fulfillment automation  
\- customer tracking or notifications  
\- departments, manager hierarchy, QC approvals, escalations  
\- scheduling, capacity planning, analytics, time tracking, payroll, or chat  
\- inventory, BOMs, purchasing, quoting, invoicing, CRM  
\- deep embroidery/manufacturing semantics  
\- file/artwork management  
\- billing or pricing implementation  
\- production-ready identity/security feature set  
\- App Store submission work

Success criteria

The spike succeeds if:

1\. The owner can open the embedded app and see a few Shopify-derived test jobs.  
2\. The owner can invite one external worker.  
3\. The worker can authenticate through an email magic link without Shopify access.  
4\. The worker sees the permitted test work and can perform Start, Block, and Done.  
5\. The owner sees those changes and their actor/timestamps inside Shopify.  
6\. Tenant separation is understandable and the worker cannot simply address another shop's Baton data.  
7\. The resulting code and architecture still feel small, comprehensible, and reusable for future Shopify apps with non-admin participants.

Failure / rescope signals

Stop or cut scope if the spike starts forcing decisions about a general workflow engine, elaborate synchronization, complex permissions, production-domain rules, or a full external workforce-management product.

End-of-spike output

Do not turn the spike itself into a V1 spec. When it is done, record only:

\- the architecture that actually worked;  
\- important implementation surprises;  
\- anything that had to be cut or simplified;  
\- whether external auth, tenant isolation, Shopify data access, and shared workflow state felt tractable;  
\- whether a larger V1 still looks plausibly bounded.

Then return to the competitor deep dive / merchant-validation process before treating Baton as a commercially validated product.  
n
