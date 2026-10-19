import { HELP_BODIES } from "./help/bodies.tsx";
import { HELP_SECTIONS, type HelpPage, type HelpSection } from "./help/pages.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { HelpList } from "./screen/HelpList.tsx";
import { Things } from "./screen/Things.tsx";

/**
 * The hub: one sentence on Baton, then the sections. The breadcrumb is the public landing page,
 * the way back to the app for both readers.
 */
export function HelpHub() {
  const navigate = useNavigateOnClick();
  return (
    <s-page heading="Help" inlineSize="base">
      <s-link slot="breadcrumb-actions" {...navigate("/")}>
        Baton
      </s-link>
      <s-section accessibilityLabel="About Baton">
        <Things>
          <s-paragraph>
            Baton takes each item a Shopify order sells through a workflow of steps, and shows the
            members on each team what to make next.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="In this section">
        <HelpList entries={HELP_SECTIONS} hrefOf={(section) => `/help/${section.slug}`} />
      </s-section>
    </s-page>
  );
}

/** A section hub: the lead (the section's one line), then "In this section" over its pages. */
export function HelpSectionHub({ section }: { readonly section: HelpSection }) {
  const navigate = useNavigateOnClick();
  return (
    <s-page heading={section.title} inlineSize="base">
      <s-link slot="breadcrumb-actions" {...navigate("/")}>
        Baton
      </s-link>
      <s-link slot="breadcrumb-actions" {...navigate("/help")}>
        Help
      </s-link>
      <s-section accessibilityLabel={section.title}>
        <Things>
          <s-paragraph>{section.description}</s-paragraph>
        </Things>
      </s-section>
      <s-section heading="In this section">
        <HelpList entries={section.pages} hrefOf={(page) => `/help/${section.slug}/${page.slug}`} />
      </s-section>
    </s-page>
  );
}

/**
 * A page: breadcrumbs up to its section, the lead (the page's one line), the body when
 * {@link HELP_BODIES} has one for the page, and the foot list, "In <section>", the section's pages
 * with this one unlinked. The foot list is the sideways device in place of a sidebar, and on a
 * phone, where `s-page` folds the breadcrumbs into a "…" button, the visible way up.
 */
export function HelpArticle({
  section,
  page,
}: {
  readonly section: HelpSection;
  readonly page: HelpPage;
}) {
  const navigate = useNavigateOnClick();
  const Body = HELP_BODIES[`${section.slug}/${page.slug}`];
  const sectionHref = `/help/${section.slug}`;
  return (
    <s-page heading={page.title} inlineSize="base">
      <s-link slot="breadcrumb-actions" {...navigate("/")}>
        Baton
      </s-link>
      <s-link slot="breadcrumb-actions" {...navigate("/help")}>
        Help
      </s-link>
      <s-link slot="breadcrumb-actions" {...navigate(sectionHref)}>
        {section.title}
      </s-link>
      <s-section accessibilityLabel={page.title}>
        <Things>
          <s-paragraph>{page.description}</s-paragraph>
        </Things>
      </s-section>
      {Body === undefined ? null : <Body />}
      {/* The heading names the section as a link: on a phone, where the breadcrumbs have
          folded, it is the visible way up. */}
      <s-section accessibilityLabel={`In ${section.title}`}>
        <Things>
          <s-heading>
            In <s-link {...navigate(sectionHref)}>{section.title}</s-link>
          </s-heading>
          <HelpList
            entries={section.pages}
            hrefOf={(entry) => `${sectionHref}/${entry.slug}`}
            current={page.slug}
          />
        </Things>
      </s-section>
    </s-page>
  );
}

/** What a slug the tree does not have renders, with the way back to the hub. */
export function HelpNotFound() {
  const navigate = useNavigateOnClick();
  return (
    <s-page heading="Page not found" inlineSize="small">
      <s-link slot="breadcrumb-actions" {...navigate("/help")}>
        Help
      </s-link>
      <s-section accessibilityLabel="Page not found">
        <Things>
          <s-paragraph color="subdued">There is no help page here.</s-paragraph>
          <s-link {...navigate("/help")}>Help</s-link>
        </Things>
      </s-section>
    </s-page>
  );
}
