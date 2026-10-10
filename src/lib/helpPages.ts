/**
 * The help tree: the one source the help routes read, so a page's breadcrumbs,
 * a hub's "In this section" list and a page's foot list cannot drift from each
 * other. Three levels and no more: Help, a section, a page. A section has
 * pages and a page has no children, so the shape holds the depth.
 *
 * The slugs are the URL (`/help/<section>/<page>`); the titles are the page
 * headings (a gerund for a task page, a noun for a hub, a concept or a
 * reference page); the description is the one line under a title in a list
 * and the lead of the page while it has no body. Every string here is screen
 * copy and speaks the vocabulary's screen words.
 */
export interface HelpPage {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}

export interface HelpSection extends HelpPage {
  readonly pages: readonly HelpPage[];
}

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description:
      "Install Baton, create a team and a workflow, and follow the first order through.",
    pages: [
      {
        slug: "how-baton-works",
        title: "How Baton works",
        description:
          "Baton takes each order's items through a workflow of steps, each step's tasks done by a team of members.",
      },
      {
        slug: "installing",
        title: "Installing Baton and choosing a plan",
        description: "From the App Store to the pricing page and the trial.",
      },
      {
        slug: "first-team",
        title: "Creating a team and adding members",
        description: "A team for the tasks, and the people who do them.",
      },
      {
        slug: "first-workflow",
        title: "Creating your first workflow",
        description:
          "Name it, give it a tag, add a step and a task, assign a team, turn it on.",
      },
      {
        slug: "first-order",
        title: "Following an order through its workflow",
        description:
          "An item's product has the tag, a member starts the work, and the order reads Made.",
      },
    ],
  },
  {
    slug: "orders",
    title: "Orders",
    description:
      "What the orders list and the order page show, and what to do about an issue.",
    pages: [
      {
        slug: "orders-list",
        title: "Reading the orders list",
        description:
          "The positions and Issues at the top, the Show menu, the Team menu and search.",
      },
      {
        slug: "order-page",
        title: "Reading an order",
        description:
          "Each item's workflow, step and team, the order note, and Open in Baton from Shopify.",
      },
      {
        slug: "attaching-a-workflow",
        title: "Attaching or changing a workflow",
        description:
          "The Workflow menu on an item, Change workflow, and Cancel workflow.",
      },
      {
        slug: "fixing-issues",
        title: "Fixing an issue",
        description:
          "Multiple workflows match, Needs a team and Blocked: what each means and how to fix each.",
      },
      {
        slug: "syncing",
        title: "Syncing from Shopify",
        description:
          "When Baton reads orders, Sync open orders, Sync from Shopify on an order, and the open-order limit.",
      },
    ],
  },
  {
    slug: "workflows",
    title: "Workflows",
    description: "The steps and tasks an item goes through, and who does them.",
    pages: [
      {
        slug: "creating",
        title: "Creating a workflow",
        description: "Create workflow, its name and its tag.",
      },
      {
        slug: "editing",
        title: "Editing steps and tasks",
        description:
          "Add a step or a task, write instructions, assign a team, then Apply changes or Discard changes.",
      },
      {
        slug: "matching",
        title: "Matching items by product tag",
        description:
          "One tag per workflow, an exact match, and what happens when two workflows match.",
      },
      {
        slug: "turning-on-and-off",
        title: "Turning a workflow on or off",
        description:
          "Active and Inactive, and what Turn off does to items already on it.",
      },
      {
        slug: "managing",
        title: "Renaming, duplicating and deleting a workflow",
        description: "The More actions menu on the workflow page.",
      },
    ],
  },
  {
    slug: "teams-and-members",
    title: "Teams and members",
    description:
      "A team holds tasks. A member is on one or more teams and works their tasks.",
    pages: [
      {
        slug: "creating-a-team",
        title: "Creating a team",
        description: "Create team, Add members, Rename.",
      },
      {
        slug: "adding-a-member",
        title: "Adding a member",
        description:
          "Add member by email, no Shopify account needed, and what the member sees next.",
      },
      {
        slug: "removing-and-deleting",
        title: "Removing and deleting",
        description:
          "Remove from a team, Delete member, Delete team, and what happens to open tasks.",
      },
    ],
  },
  {
    slug: "members",
    title: "For members",
    description:
      "You were added by the merchant. Sign in, find your work and mark it done.",
    pages: [
      {
        slug: "signing-in",
        title: "Signing in",
        description: "The email link, Your stores, and Sign out.",
      },
      {
        slug: "finding-your-work",
        title: "Finding your work",
        description: "The five filters at the top, the Team menu and search.",
      },
      {
        slug: "recording-your-work",
        title: "Starting and finishing tasks",
        description: "Start, Done, Put back and Undo on an item's page.",
      },
      {
        slug: "blocking",
        title: "Blocking an item and leaving a note",
        description:
          "Block with a reason, Unblock, Edit note, and what the merchant sees.",
      },
    ],
  },
  {
    slug: "reference",
    title: "Reference",
    description: "What each badge means, who can do what, limits and plans.",
    pages: [
      {
        slug: "states-and-badges",
        title: "Badges",
        description:
          "What each badge means on an order, an item, a task, a workflow, a team and a member.",
      },
      {
        slug: "who-can-do-what",
        title: "Who can do what",
        description: "Which buttons a member has and which you have.",
      },
      {
        slug: "limits",
        title: "Limits",
        description:
          "Members, open orders, workflows, teams and order history.",
      },
      {
        slug: "plans-and-billing",
        title: "Plans and billing",
        description:
          "What each plan includes, which orders and members you pay for, and changing plans.",
      },
    ],
  },
];

export const findHelpSection = (slug: string): HelpSection | undefined =>
  HELP_SECTIONS.find((section) => section.slug === slug);

export const findHelpPage = (
  section: HelpSection,
  slug: string,
): HelpPage | undefined => section.pages.find((page) => page.slug === slug);

/** The browser tab's title for a help page. */
export const helpTabTitle = (title: string) => `${title} — Baton help`;
