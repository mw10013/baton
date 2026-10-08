import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Creating a team (`teams-and-members/creating-a-team`): the Teams page,
 * Create team, Add members, Rename. Read against
 * `src/routes/app.teams.index.tsx` (the Team and Members columns; the No
 * members badge beside a team's name when its count is zero; "Search by
 * name", over every team; Create team, its Name field and Create; the
 * name-taken error under the field; the team limit banner; the new team's
 * page opens), `src/routes/app.teams.$teamId.tsx` (the "Nobody on this team
 * yet" empty state; Add members and its modal, which lists only members not
 * yet on the team, with a search by email from `SEARCH_FROM` candidates,
 * "Everyone is already on this team." when none are left, and a pointer to
 * the Members page when the shop has no members; the Members table with
 * Remove per row; More actions with Rename and Delete; the Rename team modal
 * with Name and Save; the Details aside), `NAME_TAKEN` and `SEARCH_FROM` in
 * `src/lib/teams.ts`, `TeamName` and `TEAM_NAME_MAX_LENGTH` in
 * `src/lib/domain/ShopWork.ts` (trimmed, case kept, compared exactly), the
 * team row of `D1_TABLES` in `src/lib/D1Schema.ts` (unique within a shop),
 * the JSDoc on `WorkflowTask` (`teamId` is a live pointer, so a rename
 * renames every workflow task) and on `RunTask` (`teamName` is a snapshot
 * a rename never reaches, shown by `RunSteps` on the order page and the
 * member screens). No number is named here: Limits has them.
 */
export function CreatingATeam() {
  return (
    <>
      <s-section heading="The Teams page">
        <Things>
          <s-paragraph>
            Each row is a team: its name and how many members are on it. A team
            nobody is on reads <strong>No members</strong> beside its name. Its
            tasks still start on new items, but nobody can work them until
            someone joins. To find one team, search by name.
          </s-paragraph>
          <HelpPicture name="creatingATeam1" />
        </Things>
      </s-section>
      <s-section heading="Create a team">
        <Things>
          <NumberedList
            items={[
              <>
                On the Teams page, press <strong>Create team</strong>.
              </>,
              <>
                Enter a <strong>Name</strong>, such as Assembly.
              </>,
              <>
                Press <strong>Create</strong>.
              </>,
            ]}
          />
          <HelpPicture name="firstTeam1" />
          <s-paragraph>
            The team&apos;s page opens. It says nobody is on the team yet, and
            its tasks wait until a member joins. No two teams share a name.
            Baton compares names exactly, so Sewing and sewing are two teams. If
            another team has the name, the screen says so under the field. How
            long a name can be, and how many teams a shop can have, is in{" "}
            <s-link href="/help/reference/limits">Limits</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Add members to a team">
        <Things>
          <NumberedList
            items={[
              <>
                On the team&apos;s page, press <strong>Add members</strong>.
              </>,
              <>
                Tick the email of each member to add. With a long list, search
                by email first.
              </>,
              <>
                Press <strong>Add</strong>.
              </>,
            ]}
          />
          <HelpPicture name="firstTeam2" />
          <s-paragraph>
            The list holds the members you have already added to Baton who are
            not on this team yet. A member can be on several teams. When
            everyone is on the team, the modal says so. To add someone new to
            Baton, see{" "}
            <s-link href="/help/teams-and-members/adding-a-member">
              Adding a member
            </s-link>
            .
          </s-paragraph>
          <s-paragraph>
            The team&apos;s page lists its members by email, with{" "}
            <strong>Remove</strong> at the end of each row. The Details section
            shows how many members it has and when it was created.
          </s-paragraph>
          <HelpPicture name="creatingATeam2" />
        </Things>
      </s-section>
      <s-section heading="Rename a team">
        <Things>
          <NumberedList
            items={[
              <>
                On the team&apos;s page, press <strong>More actions</strong>,
                then <strong>Rename</strong>.
              </>,
              <>
                Enter the new <strong>Name</strong>.
              </>,
              <>
                Press <strong>Save</strong>.
              </>,
            ]}
          />
          <s-paragraph>
            The workflow pages show the new name on every task the team has.
            Tasks on items already on a workflow keep the name the team had when
            they got it, on the order page and on the members&apos; screens.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
