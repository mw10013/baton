import { Effect, Option, Schema } from "effect";

import { runCommand } from "./command.ts";

/**
 * A thin layer over the `herdr` CLI (herdr 0.9.0), which any process in a
 * Herdr pane can use to inspect and control the session (`HERDR_ENV=1`).
 * Control commands answer JSON shaped `{ id, result }`; each schema here
 * decodes only the fields the dev command reads. `pane read` answers plain
 * text.
 */

export const inHerdr = () => process.env.HERDR_ENV === "1";

const Envelope = Schema.fromJsonString(
  Schema.Struct({ result: Schema.Unknown }),
);

const herdr = <A, I>(args: readonly string[], result: Schema.Codec<A, I>) =>
  runCommand("herdr", args).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Envelope)),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(result)(response.result),
    ),
  );

const Pane = Schema.Struct({
  pane_id: Schema.String,
  tab_id: Schema.String,
  workspace_id: Schema.String,
  cwd: Schema.optional(Schema.String),
});
export type Pane = typeof Pane.Type;

export const listPanes = herdr(
  ["pane", "list"],
  Schema.Struct({ panes: Schema.Array(Pane) }),
).pipe(Effect.map(({ panes }) => panes));

const ForegroundProcess = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
});

/**
 * A pane's foreground process group. The shell is at its prompt, with nothing
 * running in front of it, exactly when the foreground group is the shell's
 * own: `foreground_process_group_id` equals `shell_pid`.
 */
export const processInfo = (paneId: string) =>
  herdr(
    ["pane", "process-info", "--pane", paneId],
    Schema.Struct({
      process_info: Schema.Struct({
        shell_pid: Schema.Number,
        foreground_process_group_id: Schema.Number,
        foreground_processes: Schema.Array(ForegroundProcess),
      }),
    }),
  ).pipe(
    Effect.map(({ process_info: info }) => ({
      idle: info.foreground_process_group_id === info.shell_pid,
      processes: info.foreground_processes,
    })),
  );

/**
 * The workspace Herdr has open on the checkout at `path`, from
 * `worktree list`, which answers for the main checkout and every linked
 * worktree of its repository. None when no workspace is open on it.
 */
export const checkoutWorkspace = (path: string) =>
  herdr(
    ["worktree", "list", "--cwd", path],
    Schema.Struct({
      worktrees: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          open_workspace_id: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ).pipe(
    Effect.map(({ worktrees }) =>
      Option.fromNullishOr(
        worktrees.find((worktree) => worktree.path === path)?.open_workspace_id,
      ),
    ),
  );

const Tab = Schema.Struct({ tab_id: Schema.String, label: Schema.String });
export type Tab = typeof Tab.Type;

export const listTabs = (workspaceId: string) =>
  herdr(
    ["tab", "list", "--workspace", workspaceId],
    Schema.Struct({ tabs: Schema.Array(Tab) }),
  ).pipe(Effect.map(({ tabs }) => tabs));

export const renameTab = (tabId: string, label: string) =>
  runCommand("herdr", ["tab", "rename", tabId, label]);

const PaneRef = Schema.Struct({ pane_id: Schema.String });

/** Creates an unfocused tab and returns its root pane. It is appended: `tab create` takes no position. */
export const createTab = (options: {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly label: string;
}) =>
  herdr(
    [
      "tab",
      "create",
      "--workspace",
      options.workspaceId,
      "--cwd",
      options.cwd,
      "--label",
      options.label,
      "--no-focus",
    ],
    Schema.Struct({ root_pane: PaneRef }),
  ).pipe(Effect.map(({ root_pane }) => root_pane.pane_id));

/** Splits `paneId` downward without taking focus and returns the new pane. */
export const splitPane = (paneId: string, cwd: string) =>
  herdr(
    [
      "pane",
      "split",
      "--pane",
      paneId,
      "--direction",
      "down",
      "--cwd",
      cwd,
      "--no-focus",
    ],
    Schema.Struct({ pane: PaneRef }),
  ).pipe(Effect.map(({ pane }) => pane.pane_id));

/** The panes of `paneId`'s tab, top to bottom, then left to right. */
export const panesInLayoutOrder = (paneId: string) =>
  herdr(
    ["pane", "layout", "--pane", paneId],
    Schema.Struct({
      layout: Schema.Struct({
        panes: Schema.Array(
          Schema.Struct({
            pane_id: Schema.String,
            rect: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
          }),
        ),
      }),
    }),
  ).pipe(
    Effect.map(({ layout }) =>
      layout.panes
        .toSorted((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
        .map((pane) => pane.pane_id),
    ),
  );

/** Types `command` and Enter into the pane's shell. */
export const runInPane = (paneId: string, command: string) =>
  runCommand("herdr", ["pane", "run", paneId, command]);

export const sendKeys = (paneId: string, keys: string) =>
  runCommand("herdr", ["pane", "send-keys", paneId, keys]);

export const readPane = (paneId: string, lines: number) =>
  runCommand("herdr", [
    "pane",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(lines),
  ]);
