() => {
  const LONG_TITLE =
    "Engraved cutting board, extra large end-grain walnut with a hand-cut juice groove, rounded finger grips, a personalized inscription across the front face, a food-safe oil finish, and gift wrapping for the day";
  const LONG_REASON =
    "The crest is a scan of a wax seal and the fine lines fill in at this depth; we have tried three passes and it still reads as a smudge, so we are waiting on vector artwork from the customer. ".repeat(
      5,
    );
  const T64 =
    "Condition and burnish the edges against the customer's reference";
  const TEAM32 = "Hand stitching and edge painting";
  const rows = [
    {
      head: ["#1008", "Signet ring · Gold"],
      qty: "×2",
      tasks: [["Engrave crest", "Engraving", null]],
      block: "Crest file missing from the order — asked the customer.",
      recipe: "Step 2 of 3",
    },
    {
      head: ["#1026", LONG_TITLE],
      qty: null,
      tasks: [["Engrave", "Engraving", null]],
      block: LONG_REASON,
      recipe: "Cut, engrave and oil · Step 2 of 3",
    },
    {
      head: ["#1030", "Heirloom leather journal"],
      qty: null,
      tasks: [
        [T64, TEAM32, "Ready"],
        ["Cut the cover panels to pattern", "Leather", "Ready"],
        ["Skive the turn-ins", TEAM32, "Started by you"],
      ],
      block: null,
      recipe: "Step 2 of 18",
    },
    {
      head: [
        "#WEB-1000234-EU",
        LONG_TITLE +
          " · Solid 18k yellow gold / Size 11½ / Extra-deep engraving",
      ],
      qty: "×12",
      tasks: [
        [
          "Engrave the inscription across the full width of the front face",
          "Engraving and laser, bench 3",
          "Started by alexandra.featherstonehaugh@example-workshop.com",
        ],
      ],
      block: null,
      recipe: "Engraved boards, rush and standard · Step 14 of 18",
    },
    {
      head: ["#1030", "Heirloom leather journal"],
      qty: null,
      tasks: [["Select and inspect the hide", null, "Done by you · 12:51 PM"]],
      block: null,
      recipe: null,
    },
  ];
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  };
  const t = (text, attrs) => h("s-text", attrs, text);
  const list = document.querySelector(".run-line").closest("s-clickable")
    .parentElement.parentElement;
  list.innerHTML = "";
  rows.forEach((r, i) => {
    const head = h(
      "div",
      { class: "run-line" },
      h(
        "div",
        { class: "run-title-clip" },
        t(`${r.head[0]} · `, { color: "subdued" }),
        t(r.head[1], { fontweight: "semibold" }),
      ),
      r.qty &&
        h(
          "div",
          { class: "run-line-keep" },
          t(` ${r.qty}`, { fontweight: "semibold" }),
        ),
    );
    const body = h(
      "div",
      {
        style:
          "display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere;grid-column:1 / -1",
      },
      r.tasks.map(([name, team, state]) =>
        h(
          "div",
          null,
          t(name),
          team && t(` (${team})`, { color: "subdued" }),
          state && t(` · ${state}`, { color: "subdued" }),
        ),
      ),
      r.block &&
        h("s-paragraph", { lineclamp: "2", color: "subdued" }, r.block),
      r.recipe && h("div", null, t(r.recipe, { color: "subdued" })),
    );
    const grid = h(
      "div",
      {
        style:
          "display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;row-gap:2px;align-items:start",
      },
      head,
      h(
        "div",
        { style: "block-size:20px;display:flex;align-items:center" },
        h("s-button", {
          icon: "menu-horizontal",
          variant: "tertiary",
          accessibilityLabel: "Actions",
        }),
      ),
      body,
    );
    list.append(
      h(
        "div",
        {
          style:
            (i ? "border-top:1px solid #e3e3e3;" : "") + "padding:8px 16px",
        },
        grid,
      ),
    );
  });
  return "ok";
};
