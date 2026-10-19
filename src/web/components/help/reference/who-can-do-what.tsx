import * as Struct from "effect/Struct";

import { HelpTable } from "../../screen/HelpTable.tsx";
import { Things } from "../../screen/Things.tsx";
import * as ShopWork from "../../../../domain/shop-work.ts";
import { RECORD_VERB_ROWS, WORK_VERB_ROWS, WORKFLOW_VERB_ROWS } from "../reference.ts";

/** A verb's button word in one screen column, bold, or an empty cell where that side never offers it (`null` in {@link ShopWork.VERB_LABEL}). */
const buttonCell = (label: string | null) => (label === null ? "" : <strong>{label}</strong>);

/**
 * Who can do what (`reference/who-can-do-what`), a reference page: the work
 * verbs with each side's button and when it is offered, the merchant's
 * workflow and record verbs, and what a member sees. The button words are
 * `VERB_LABEL` and `RECORD_VERB_LABEL`; every other cell is
 * `helpReference`, whose JSDoc names what each row set was
 * checked against: `taskActions` and `runActions` (Start the member's alone; Done and Put back
 * on the current task and stopped by a block; Put back and Undo for the
 * task's whole team; Undo while no later step's task is started or done,
 * offered under a block and on a done workflow, never on a closed one;
 * Assign team on any task not done while the workflow is open, blocked or
 * not; the note for every team with a task on the item and the merchant, in
 * every state; Block and Unblock for the current task's team and the
 * merchant; Cancel workflow on an open workflow; Change workflow with units
 * to make in any state; nothing but the note on a closed order),
 * `lineItemState` and `orderIsOpen` (Attach on an item with no workflow and
 * units to make, on an open order, paid or not), the Verbs and Record verbs
 * tables, and `runIsVisibleTo` with the no-team empty line in
 * `WorkflowsListPage` (a member sees an item while
 * one of their teams has a task on it).
 *
 * The record verbs table's first column is the button, not a "What" column
 * as in the work verbs table: each has one button word and one side, so
 * the button is the row's title, which is the shape rule on a reference
 * page.
 */
export function WhoCanDoWhat() {
  return (
    <>
      <s-section heading="Work on an item">
        <Things>
          <s-paragraph>
            A member presses these on the item&apos;s page and the Workflows list. You press them on
            the order&apos;s page, most of them under Manage. An open order is one not yet fulfilled
            or cancelled in Shopify. On a fulfilled or cancelled order, only the note can change.
          </s-paragraph>
          <HelpTable
            columns={["What", "Member", "Merchant", "When"]}
            rows={Struct.keys(WORK_VERB_ROWS).map((verb) => [
              WORK_VERB_ROWS[verb].what,
              buttonCell(ShopWork.VERB_LABEL[verb].member),
              buttonCell(ShopWork.VERB_LABEL[verb].merchant),
              WORK_VERB_ROWS[verb].when,
            ])}
          />
          <s-paragraph>
            <strong>{ShopWork.VERB_LABEL.reopen.member}</strong> and{" "}
            <strong>{ShopWork.VERB_LABEL.reopen.merchant}</strong> are one button with two names. A
            task in a later step offers only <strong>{ShopWork.VERB_LABEL.assign.merchant}</strong>,
            to you.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Workflows, teams and members">
        <Things>
          <s-paragraph>
            Only you have these. A member&apos;s screens offer none of them.
          </s-paragraph>
          <HelpTable
            columns={["Button", "On", "Does"]}
            rows={[
              ...Struct.keys(WORKFLOW_VERB_ROWS).map((verb) => [
                buttonCell(ShopWork.VERB_LABEL[verb].merchant),
                WORKFLOW_VERB_ROWS[verb].on,
                WORKFLOW_VERB_ROWS[verb].does,
              ]),
              ...ShopWork.RecordVerb.literals.map((verb) => [
                buttonCell(ShopWork.RECORD_VERB_LABEL[verb]),
                RECORD_VERB_ROWS[verb].on,
                RECORD_VERB_ROWS[verb].does,
              ]),
            ]}
          />
        </Things>
      </s-section>
      <s-section heading="What a member sees">
        <s-paragraph>
          A member sees an item only when one of their teams has a task in its workflow, at any
          step. They read and write its note too. You see every order and every item. A member on no
          team sees no items, and their Workflows list tells them to ask you for a team.
        </s-paragraph>
      </s-section>
    </>
  );
}
