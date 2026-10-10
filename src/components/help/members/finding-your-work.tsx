import { HelpPicture } from "@/components/screen/HelpPicture";
import { Things } from "@/components/screen/Things";

/**
 * Finding your work (`members/finding-your-work`): the Workflows list's five
 * filters, the Team menu, search and Show more. Read against
 * `src/routes/shop.$shop.workflows.index.tsx` and `RunRepository.runListItems`
 * (an item is listed while its current task is on one of your teams),
 * `ShowMore` in `src/components/screen/ShowMore.tsx` ("Show n more of N"),
 * `src/lib/workflowsListStates.ts` (the labels and their order), and
 * `Domain.listStateOf` (a block wins, then a task you started, then any
 * started task, then Ready), `Domain.RecentItem` and
 * `Domain.workflowsListStateIsDone` (Done or closed holds the last day,
 * `DONE_WINDOW_MS`), `Domain.RunQuery` (a search ignores the state and the
 * team), `Domain.searchTerm` (an order number matched whole, else the start
 * of a word in the item's title, variant or SKU) and `Domain.RUN_PAGE` (25).
 */
export function FindingYourWork() {
  return (
    <>
      <s-section heading="Choose what to see">
        <Things>
          <s-paragraph>
            The Workflows list shows the items whose current task is on one of
            your teams. The counts at the top show how many each filter holds.
            Press a filter to list its items.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <strong>Started by you</strong>: items with a task you started.
              The list opens here.
            </s-list-item>
            <s-list-item>
              <strong>Started by others</strong>: someone else started the task.
            </s-list-item>
            <s-list-item>
              <strong>Ready</strong>: every earlier step is done and nobody has
              started the task. Anyone on its team can.
            </s-list-item>
            <s-list-item>
              <strong>Blocked</strong>: someone stopped the work and said why. A
              blocked item is listed here, not under Started by you, Started by
              others or Ready.
            </s-list-item>
            <s-list-item>
              <strong>Done or closed</strong>: tasks your teams did in the last
              day, and items whose workflow ended in that time, with the reason.
            </s-list-item>
          </s-unordered-list>
          <HelpPicture name="findingYourWork1" />
          <s-paragraph>
            Each row shows the order number and the item, then the current task
            and its badge, then the workflow and its step. Press a row to open
            the item&apos;s page.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Narrow the list">
        <Things>
          <s-paragraph>
            If you are on more than one team, a <strong>Team</strong> menu sits
            under the search. Choose a team to see its work alone. The counts at
            the top cover only that team&apos;s items.
          </s-paragraph>
          <HelpPicture name="findingYourWork2" />
          <s-paragraph>
            To find one item, search by its order number, or by the start of a
            word in the item&apos;s title, variant or SKU. A search looks across
            every filter and every team. Press <strong>Clear search</strong> to
            go back to the list you had.
          </s-paragraph>
          <s-paragraph>
            The list shows 25 at a time. The button at its foot says how many
            are left, such as <strong>Show 25 more of 40</strong>, and loads up
            to 25 more.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
