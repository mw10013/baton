import * as DateTime from "effect/DateTime";
import type { Member } from "../../domain/shop-work.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { IndexSection } from "./screen/IndexSection.tsx";
import SignOutButton from "./SignOutButton.tsx";

/**
 * Every shop's members: one row per `Member`, so an email in two shops is two rows. An admin
 * sub-page: the Admin breadcrumb back and Sign out as the page's action, with no bar.
 */
export default function MembersPage({ members }: { members: ReadonlyArray<Member> }) {
  const navigate = useNavigateOnClick();
  return (
    <s-page heading="Members">
      <s-link slot="breadcrumb-actions" {...navigate("/admin")}>
        Admin
      </s-link>
      <SignOutButton variant="secondary" slot="secondary-actions" leave />
      <IndexSection label="Members">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="secondary">Shop</s-table-header>
            <s-table-header listSlot="primary">Email</s-table-header>
            <s-table-header listSlot="inline">Added</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {members.map((member) => (
              <s-table-row key={member.id}>
                <s-table-cell>{member.shop}</s-table-cell>
                <s-table-cell>{member.email}</s-table-cell>
                <s-table-cell>
                  {DateTime.formatIsoDateUtc(DateTime.makeUnsafe(member.createdAt))}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </IndexSection>
    </s-page>
  );
}
