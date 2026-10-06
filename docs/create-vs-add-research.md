# Create or Add: the verb for a new member, team or workflow

Written 2026-10-06, after commit 7293b1f. The question: Baton's buttons say Create team, Create
workflow and Create member. Earlier builds said Add for some of them. Baton is an embedded admin
app and should read like the Shopify admin. Which verb does Shopify use, by what rule, and what
should Baton do?

Sources: the live admin of `sandbox-shop-00`, surveyed 2026-10-06 without saving anything; the app
design guidance in `refs/shopify-docs/docs/apps/design/` and the App Home pattern templates in
`refs/shopify-docs/docs/api/app-home/latest/patterns/`; the Admin GraphQL mutation names in
`refs/shopify-docs/docs/api/admin-graphql/latest/mutations/`. The old Polaris content pages
(`polaris.shopify.com/content/actionable-language`) now redirect to shopify.dev and could not be
read; the shopify.dev content page says only "use a single verb for a single action" and
"start with a strong verb".

## Short answers

- **The Shopify admin has no single rule.** Products, collections, customers, locations and staff
  use Add. Orders, transfers, purchase orders, gift cards, segments, discounts, markets, menus and
  blog posts use Create. Several resources use both, and some use "New" in the page title.
- **Deletability does not decide it.** Products can be deleted (Delete product, beside Archive
  product). Orders can be deleted too (Delete order, beside Cancel order and Archive). So "Add
  because you can't delete it" and "Create because you can't delete it" both fail.
- **The visible pattern is age, not meaning.** The original catalog and people resources (products,
  collections, customers, locations, staff) say Add. The resources built or rebuilt later
  (segments, markets, transfers, purchase orders, the discount editor) say Create.
- **Shopify's guidance for apps says Create for the app's own things and Add for bringing existing
  things in.** The App Home resource index template has "Create puzzle" as its primary action, and
  "Add products" for picking Shopify products into the app's list with the Resource Picker. The
  onboarding and content pages show "Create puzzle" and "Create template". That is exactly
  Baton's current rule.
- **The Admin API holds the same line.** `productCreate`, `collectionCreate`, `customerCreate`,
  `orderCreate`, `marketCreate`, each with a `…Delete`; `collectionAddProducts`,
  `collectionRemoveProducts`, `tagsAdd`, `tagsRemove` for membership. `locationAdd` is the one
  outlier.
- **Two places where Baton could match the admin more closely**: people (Shopify says Add customer
  and Add users) and parts made inside a parent (Shopify says Add menu item, Add condition, Add
  address). See the questions.

## What the admin shows

Exact words, read 2026-10-06. "—" means not checked.

| resource          | index button                                    | new page or modal title | delete                              |
| ----------------- | ----------------------------------------------- | ----------------------- | ----------------------------------- |
| Orders            | Create order                                    | Create order            | Delete order, Cancel order, Archive |
| Draft orders      | Create order                                    | Create order            | —                                   |
| Products          | Add product                                     | Add product             | Delete product, Archive product     |
| Collections       | Add collection                                  | Add collection          | Delete collection                   |
| Customers         | Add customer                                    | New customer            | Delete customer                     |
| Locations         | Add location                                    | Add location            | —                                   |
| Staff             | Add users                                       | Add users               | —                                   |
| Shipping profiles | Add custom profile                              | —                       | —                                   |
| Metaobjects       | Add definition                                  | —                       | —                                   |
| Segments          | Create segment                                  | New segment             | —                                   |
| Discounts         | Create discount                                 | Create discount         | —                                   |
| Markets           | Create market                                   | New market              | —                                   |
| Menus             | Create menu                                     | Add menu                | —                                   |
| Blog posts        | Create blog post                                | Add blog post           | —                                   |
| Gift cards        | Create gift card (beside Add gift card product) | Create gift card        | —                                   |
| Transfers         | Create transfer                                 | Create transfer         | —                                   |
| Purchase orders   | Create purchase order                           | Create purchase order   | —                                   |
| Files             | Upload files                                    | (no page)               | —                                   |

The keyboard-shortcut list says "Add order" and "Add discount" where the buttons say Create. Menus
and blog posts say Create on the index and Add on the page they open.

Inside a thing, the admin uses Add for both kinds of "put something here":

- **An existing thing into a set:** Add products (collection), Add collections and Add tags
  (product), Add product (draft order), Add to batch (order). Once the set has members, the
  product page's buttons become Edit collections and Edit tags.
- **A new part made inside its parent:** Add menu item, Add condition (automated collection,
  market), Add address (customer), Add options like size or color (product), Add note (order),
  Add adjustment (purchase order). None of these say Create.

The one place the admin creates inside a field is the tag picker: "Find or create tags".

## What Baton does today

The verbs table on `RECORD_VERB_LABEL` (`src/lib/domain/ShopWork.ts`): Create and Delete for a
thing that begins or stops existing in Baton; Add and Remove for a set, where both sides already
exist. The screens:

| screen          | button             | verb row |
| --------------- | ------------------ | -------- |
| Teams           | Create team        | create   |
| Workflows       | Create workflow    | create   |
| Members         | Create member      | create   |
| Team            | Add members        | add      |
| Member          | Add to teams       | add      |
| Workflow editor | Add step, Add task | (none)   |

Create member came from crud-screens decision 12 (2026-10-05), which replaced Add member on the
grounds that a member begins to exist when the email is entered.

Add step and Add task in the editor do not fit the table's own rule: a step and a task do not exist
before the button is pressed. They match the admin's "part made inside its parent" use (Add menu
item, Add condition), which the table does not name.

## Reading the evidence

Shopify's own documents for app builders and its API agree on one rule, and it is Baton's: a thing
the merchant makes is created; a thing that already exists is added to a set. The admin itself is
not a rule to follow resource by resource; its split tracks when each screen was built, and Shopify
is moving toward Create on the screens it rebuilds (segments, markets, discounts, transfers,
purchase orders). Following the admin per resource would give Baton an arbitrary mix, which the
content guidance ("use a single verb for a single action") argues against.

Two admin habits are consistent enough to count as conventions, though:

1. **People are added.** Every screen that makes a person record says Add: Add customer, Add users.
   No admin screen says Create for a person. A merchant reads "Create member" as making a person,
   which is the odd one out. The first-principles case agrees: Baton does not make the person; it
   records someone who already exists, by their email. That the Baton row is new is a storage
   fact, and the merchant never sees it.
2. **Parts inside an editor are added.** Menu items, conditions, addresses and options are new
   rows, and the admin says Add for all of them. Baton's Add step and Add task already follow this;
   only the verbs table fails to say so.

The pairing Create↔Delete and Add↔Remove is Baton's, not Shopify's: the admin pairs Add customer
with Delete customer and Add product with Delete product. So Add member does not force Remove
member for the delete; Delete member can stay, and Remove keeps meaning "off a set" only.

## Decisions

Answered 2026-10-06. No open questions remain.

1. **Team and workflow keep Create.** Both are things the merchant makes from nothing, as in the
   App Home template's "Create puzzle" and the admin's newer screens (segments, markets, discounts).
2. **Member goes back to Add member; Delete member stays for the delete.** The admin adds every
   person (Add customer, Add users), and the merchant does not make the person. This reverses
   crud-screens decision 12. The create row's "for" cell narrows to a team or a workflow, and the
   add row widens to cover a member added to the shop. The modal heading becomes Add member, the
   members index column goes from Created to Added, and `Repository.createMember` goes back to
   `addMember`.
3. **Add step and Add task keep their labels, and the add row names the rule they follow:** a part
   made inside its parent's editor (a step in a workflow, a task in a step), as in the admin's Add
   menu item and Add condition.
4. **The create modal's heading matches its button** (Create team, Add member). The admin's "New
   customer" and "New segment" are not consistent, and one word across button and heading is what
   the content guidance asks for.
