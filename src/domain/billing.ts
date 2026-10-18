import { ShopLimits } from "./platform.ts";

/**
 * A shop's members are at their ceiling when there are
 * {@link ShopLimits.maxMembers} members, on any plan. `MembershipRepository.addMember`
 * refuses a new email there, and the merchant is told how many a shop can
 * have. No shop is raised past it, so nothing offers support. It
 * is the one refusal on the members: `Entitlements.membersIncluded` bills,
 * it does not block.
 */
export const membersAtCeiling = (count: number) => count >= ShopLimits.maxMembers;
