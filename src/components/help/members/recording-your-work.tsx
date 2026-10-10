import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Starting and finishing tasks (`members/recording-your-work`): Start, Done, Put
 * back and Undo on an item's page, the instructions and the properties, and
 * what Start does to the merchant's orders list. Read against
 * `src/routes/shop.$shop.workflows.$runId.tsx` (the buttons, in the order
 * the page draws them), `Domain.taskActions` (who may press each, Done
 * without Start, Put back for the whole team, Undo while no later step's
 * task is started or done, nothing on a closed order or workflow),
 * the `menuItems` of the Workflows list's row (Start alone on a ready task,
 * Done and Put back on a started one), and `Domain.orderPosition`
 * (a started or done task makes the order Making).
 */
export function RecordingYourWork() {
  return (
    <>
      <s-section heading="Start a task and press Done">
        <Things>
          <NumberedList
            items={[
              <>On the Workflows list, press the item to open its page.</>,
              <>
                Find your task under its step: it reads <strong>Ready</strong>.
                Read its instructions and the item&apos;s properties above the
                steps, such as the text to engrave.
              </>,
              <>
                Press <strong>Start</strong>. The task reads{" "}
                <strong>Started</strong>, with your email.
              </>,
              <>
                When the work is done, press <strong>Done</strong>. The next
                step&apos;s tasks read <strong>Ready</strong> for their teams.
              </>,
            ]}
          />
          <HelpPicture name="recordingYourWork1" />
          <s-paragraph>
            You can press <strong>Done</strong> without pressing Start first.
            Baton marks it started too. On the Workflows list, the{" "}
            <strong>…</strong> button on a row has <strong>Start</strong> on a
            ready task, and <strong>Done</strong> and <strong>Put back</strong>{" "}
            on a started one.
          </s-paragraph>
          <s-paragraph>
            The merchant&apos;s orders list moves an order from{" "}
            <strong>Not started</strong> to <strong>Making</strong> when the
            first task on it is started.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Put a task back">
        <Things>
          <s-paragraph>
            If you pressed Start by mistake, or cannot do the task after all,
            press <strong>Put back</strong>. The task reads{" "}
            <strong>Ready</strong> again, for anyone on its team. Anyone on the
            team can put back a started task, not only who started it. If
            nothing else on the order was started or done, the order moves back
            to <strong>Not started</strong> on the merchant&apos;s orders list.
          </s-paragraph>
          <HelpPicture name="recordingYourWork2" />
        </Things>
      </s-section>
      <s-section heading="Undo Done">
        <Things>
          <s-paragraph>
            A done task shows <strong>Undo</strong>. It puts the task back to
            Ready. Anyone on the task&apos;s team can press it, for as long as
            no task in a later step has been started or done. After that, ask
            whoever has the later task. Once the order or the workflow is
            closed, there is no Undo.
          </s-paragraph>
          <HelpPicture name="recordingYourWork3" />
          <s-paragraph>
            The Done or closed list keeps your teams&apos; done tasks for a day,
            with Undo in the row&apos;s <strong>…</strong> button while it is
            allowed.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
