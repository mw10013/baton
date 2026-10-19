import { HelpPicture } from "../../screen/HelpPicture.tsx";
import { NumberedList } from "../../screen/NumberedList.tsx";
import { Things } from "../../screen/Things.tsx";
import { HelpLink } from "../HelpLink.tsx";

/**
 * Creating a team and adding members (`getting-started/first-team`): Create
 * team, Add members on the team's page, Add member on the Members page, and
 * what the member does next. Read against `TeamsIndexPage`
 * (Create team, its Name field and Create, then the team's page opens),
 * `TeamPage` (the "Nobody on this team yet" empty
 * state, the Add members to <team> modal with its email checkboxes, its
 * search field from `SEARCH_FROM` candidates, and
 * Add; the modal lists members already added), `MembersIndexPage`
 * (Add member, the Email field and its details line, Add, then the member's
 * page opens; adding a member sends no email), `MemberPage`
 * (the "Not on a team yet" empty state and Add to teams), and
 * `SignInPage` (the member signs in with a link sent to the email).
 */
export function FirstTeam() {
  return (
    <>
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
          <s-paragraph>
            The team&apos;s page opens. It says nobody is on the team yet. Its tasks wait until a
            member joins.
          </s-paragraph>
          <HelpPicture name="firstTeam1" />
        </Things>
      </s-section>
      <s-section heading="Add members to the team">
        <Things>
          <NumberedList
            items={[
              <>
                On the team&apos;s page, press <strong>Add members</strong>.
              </>,
              <>Tick the email of each member to add. With a long list, search by email first.</>,
              <>
                Press <strong>Add</strong>.
              </>,
            ]}
          />
          <HelpPicture name="firstTeam2" />
          <s-paragraph>
            The list holds the members you have already added to Baton. To add someone new, press{" "}
            <strong>Add member</strong> on the Members page, enter their <strong>Email</strong> and
            press <strong>Add</strong>. They don&apos;t need a Shopify account. Their page opens,
            where <strong>Add to teams</strong> puts them on a team.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="What the member does next">
        <s-paragraph>
          Baton sends no email when you add a member, so tell them yourself. They sign in to Baton
          with the email you added, and Baton sends them a sign-in link. There is no password. Once
          in, they see the tasks for their teams. A member on no team has nothing to do. Their side
          is in <HelpLink href="/help/members/signing-in">Signing in</HelpLink>.
        </s-paragraph>
      </s-section>
    </>
  );
}
