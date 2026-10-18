import type { ShopKey } from "../../contract/shop.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { Lines } from "./screen/Lines.tsx";

/**
 * The member's home, "Your stores": a link to each shop the member belongs to, in the order
 * given, or the empty state that tells a member with none who can grant access. Who is signed in
 * and Sign out are the `MemberBar`'s, above every member page.
 */
export default function MemberHomePage({ shops }: { shops: ReadonlyArray<ShopKey> }) {
  const navigate = useNavigateOnClick();
  return (
    <s-page heading="Your stores" inlineSize="small">
      <s-section accessibilityLabel="Stores">
        {shops.length === 0 ? (
          <s-paragraph color="subdued">
            You don’t have access to any shops yet. Ask the merchant to add your email on their
            Members page.
          </s-paragraph>
        ) : (
          <Lines>
            {shops.map((shop) => (
              <s-link key={shop} {...navigate(`/shop/${shop}`)}>
                {shop}
              </s-link>
            ))}
          </Lines>
        )}
      </s-section>
    </s-page>
  );
}
