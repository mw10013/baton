import type * as Domain from "@/lib/Domain";

/**
 * The team checklist shared by the members page's Add member and Edit teams
 * dialogs: one component, two entry points, so the two can never drift. Teams
 * are few (tens at most), so a checklist beats a picker here. A team with
 * nobody on it is marked so the merchant can see, while choosing, that this
 * member would be its first.
 *
 * `s-choice-list` reports its selection as `event.currentTarget.values`, not
 * per-choice `checked` events, so the parent holds the array and this stays a
 * controlled field.
 */
export function MemberTeamsFields({
  teams,
  value,
  onChange,
}: {
  readonly teams: readonly Domain.TeamRoster[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  if (teams.length === 0)
    return (
      <s-paragraph color="subdued">
        No teams yet. Create one on <s-link href="/app/teams">Teams</s-link>.
      </s-paragraph>
    );
  return (
    <s-choice-list
      label="Teams"
      name="teamIds"
      multiple
      details="Optional. A member with no team has nothing to do yet."
      values={[...value]}
      onChange={(event) => {
        onChange([...event.currentTarget.values]);
      }}
    >
      {teams.map((team) => (
        <s-choice key={team.id} value={team.id}>
          {team.name}
          {team.memberCount === 0 && (
            <>
              {" "}
              <s-text color="subdued">No members</s-text>
            </>
          )}
        </s-choice>
      ))}
    </s-choice-list>
  );
}
