import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Adding a member (`teams-and-members/adding-a-member`): the Members page,
 * Add member, Add to teams, and what the member sees next. Read against
 * `src/routes/app.members.index.tsx` (the Email and Teams columns, the No
 * teams badge in place of a zero count, "Search by email" over every member;
 * Add member, its Email field and details line, Add; `addMemberFn` returns
 * the existing row for an email already added, the member ceiling banner,
 * and the member's page opens; nothing sends an email),
 * `addMember` in `src/lib/Repository.ts` (`on conflict (shop, email) do
 * nothing`), `Email` in `src/lib/domain/Platform.ts` (trimmed and
 * lowercased on decode), `src/routes/app.members.$memberId.tsx` (the "Not
 * on a team yet" empty state; Add to teams and its modal, which lists only
 * teams the member is not on, with a search by name from `SEARCH_FROM`
 * candidates, "This member is on every team." when none are left, and a
 * pointer to the Teams page when the shop has no team; the Teams table with
 * Remove per row; the Details aside), the member rows of `D1_TABLES` in
 * `src/lib/D1Schema.ts`, `src/routes/login.tsx` and
 * `src/routes/login-callback.tsx` (Send magic link; one shop opens its
 * Workflows list, more open Your stores), and the empty list in
 * `src/routes/shop.$shop.workflows.index.tsx` for a member with no team.
 * No number is named here: Limits has them.
 */
export function AddingAMember() {
  return (
    <>
      <s-section heading="The Members page">
        <Things>
          <s-paragraph>
            Each row is a member: their email and how many teams they are on. A
            member on no team reads <strong>No teams</strong> in place of the
            number. To find one member, search by email.
          </s-paragraph>
          <HelpPicture name="addingAMember1" />
        </Things>
      </s-section>
      <s-section heading="Add a member">
        <Things>
          <NumberedList
            items={[
              <>
                On the Members page, press <strong>Add member</strong>.
              </>,
              <>
                Enter their <strong>Email</strong>.
              </>,
              <>
                Press <strong>Add</strong>.
              </>,
            ]}
          />
          <HelpPicture name="addingAMember2" />
          <s-paragraph>
            The member signs in with this email. They don&apos;t need a Shopify
            account. Baton keeps the email in lowercase, so Ana@Example.com and
            ana@example.com are one member. An email you have already added
            opens that member&apos;s page rather than adding them twice. How
            many members a shop can have is in{" "}
            <s-link href="/help/reference/limits">Limits</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Put them on teams">
        <Things>
          <s-paragraph>
            The member&apos;s page opens. It says they are not on a team yet.
            Until they are, they have nothing to work on.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                On the member&apos;s page, press <strong>Add to teams</strong>.
              </>,
              <>
                Tick each team to put them on. With a long list, search by name
                first.
              </>,
              <>
                Press <strong>Add</strong>.
              </>,
            ]}
          />
          <HelpPicture name="addingAMember3" />
          <s-paragraph>
            The list holds the teams they are not on yet. A member can be on
            several teams and sees the tasks of all of them. When they are on
            every team, the modal says so. If the shop has no team yet, it
            points you to the Teams page. The same thing from the team&apos;s
            side is <strong>Add members</strong> on a team&apos;s page, in{" "}
            <s-link href="/help/teams-and-members/creating-a-team">
              Creating a team
            </s-link>
            .
          </s-paragraph>
          <s-paragraph>
            Their page then lists their teams, with <strong>Remove</strong> at
            the end of each row. The Details section shows their email and when
            they were added.
          </s-paragraph>
          <HelpPicture name="addingAMember4" />
        </Things>
      </s-section>
      <s-section heading="What the member sees next">
        <s-paragraph>
          Baton sends no email when you add a member, so tell them yourself.
          They sign in on Baton&apos;s <strong>Sign in</strong> page with the
          email you added, and Baton sends them a sign-in link. If they work for
          one store, the link opens its Workflows list. If they work for more
          than one, it opens <strong>Your stores</strong>. A member on no team
          sees a line saying they are not on a team yet, and has nothing to do.
          Their side is in{" "}
          <s-link href="/help/members/signing-in">Signing in</s-link>.
        </s-paragraph>
      </s-section>
    </>
  );
}
