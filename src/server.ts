import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ITermBackend, SessionInfo } from "./iterm.js";
import { KEY_HELP, keysToText } from "./keys.js";
import { captureBaseline, limitOutput, newOutputSince, renderOutput, toLines, type Baseline } from "./output.js";
import { describeJob, jobStateForTty, type JobState, type ProcessLister } from "./processes.js";
import { isSelf, type SelfIdentity } from "./self.js";
import {
  DEFAULT_TIMING,
  realClock,
  waitForCommand,
  waitForQuiet,
  waitForShellReady,
  type Clock,
  type Timing,
  type WaitContext,
  type WaitResult,
} from "./wait.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ServerDeps {
  iterm: ITermBackend;
  processes: ProcessLister;
  /** Identifies the terminal the MCP client runs in, if any. Called once and cached. */
  self: () => Promise<SelfIdentity>;
  clock?: Clock;
  timing?: Partial<Timing>;
  /** How long the create_* tools wait for a new shell's prompt. */
  readyTimeoutMs?: number;
}

export const SERVER_INSTRUCTIONS = `Tools for driving iTerm2, the macOS terminal, on the user's machine.

- list_sessions shows every window, tab and pane with its session_id. Pass session_id to the other tools; without it they act on the focused session.
- run_command types a shell command, waits for it to finish and returns its output. Use send_text and send_keys for interactive programs (REPLs, prompts, editors, ssh) and to press Ctrl-C.
- read_output shows recent output; wait_for_output waits for a pattern or for a running command to finish.
- If you are running inside iTerm2 yourself, list_sessions marks your own terminal is_self. Never type into it; open split_pane (the user can watch side by side) or create_tab and use that session instead.
- For servers and watchers, start them with run_command and wait_for (e.g. "ready|listening") or a short timeout, then follow them with wait_for_output and read_output.`;

class ToolError extends Error {}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "im" : "m");
  } catch (error) {
    throw new ToolError(`Invalid regular expression ${JSON.stringify(pattern)}: ${(error as Error).message}`);
  }
}

function label(session: SessionInfo): string {
  const name = session.name ? `"${session.name}"` : "session";
  return `${name} (session_id ${session.id}, ${session.tty || "no tty"})`;
}

function jobText(job: JobState | null): string {
  if (job === null || !job.known) return "unknown";
  return job.busy ? `running: ${describeJob(job)}` : "idle at the shell prompt";
}

function formatDuration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

const sessionIdField = z
  .string()
  .min(1)
  .optional()
  .describe("Target session id (from list_sessions, create_tab, create_window or split_pane). Defaults to the focused session.");

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "iterm2-mcp", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const clock = deps.clock ?? realClock;
  const timing: Timing = { ...DEFAULT_TIMING, ...deps.timing };
  const readyTimeoutMs = deps.readyTimeoutMs ?? 10_000;
  const { iterm } = deps;

  /** Where the output of the last input we sent to each session begins. */
  const baselines = new Map<string, Baseline>();

  let selfIdentity: Promise<SelfIdentity> | null = null;
  const getSelf = () => (selfIdentity ??= deps.self());

  const jobState = async (tty: string): Promise<JobState | null> => {
    try {
      return jobStateForTty(await deps.processes(), tty);
    } catch {
      return null;
    }
  };

  const waitContext = (extra: Extra): WaitContext => {
    const progressToken = extra._meta?.progressToken;
    return {
      iterm,
      processes: deps.processes,
      clock,
      timing,
      signal: extra.signal,
      onProgress:
        progressToken === undefined
          ? undefined
          : (elapsedMs, totalMs) => {
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: elapsedMs,
                    total: totalMs,
                    message: `Waited ${formatDuration(elapsedMs)}`,
                  },
                })
                .catch(() => {});
            },
    };
  };

  /** Resolves the target session and makes sure it is not the client's own terminal. */
  const writableSession = async (sessionId: string | undefined): Promise<SessionInfo> => {
    const session = await iterm.getSession(sessionId);
    if (isSelf(session, await getSelf())) {
      const which = sessionId === undefined ? "The focused iTerm2 session" : `Session ${sessionId}`;
      throw new ToolError(
        `${which} is the terminal this assistant is running in, so typing into it would feed text into the ` +
          "conversation itself. Open a separate session with split_pane or create_tab (or pick one from " +
          "list_sessions) and pass its session_id.",
      );
    }
    return session;
  };

  const summarize = (session: SessionInfo, self: SelfIdentity, job: JobState | null) => ({
    session_id: session.id,
    name: session.name,
    window_id: session.windowId,
    tab_index: session.tabIndex,
    pane_index: session.paneIndex,
    tty: session.tty,
    cwd: session.cwd,
    size: session.columns && session.rows ? `${session.columns}x${session.rows}` : null,
    profile: session.profile,
    focused: session.isCurrent,
    active_in_tab: session.isActiveInTab,
    is_self: isSelf(session, self),
    status: jobText(job),
  });

  const describeNewSession = async (session: SessionInfo, what: string, extra: Extra): Promise<CallToolResult> => {
    const ready = await waitForShellReady(waitContext(extra), session, readyTimeoutMs);
    const [self, job] = await Promise.all([getSelf(), jobState(session.tty)]);
    const note = ready ? "" : "\nThe shell has not shown a prompt yet; it may still be starting.";
    return textResult(`${what}\n${JSON.stringify(summarize(session, self, job), null, 2)}${note}`);
  };

  /** Renders the output that appeared after `baseline`, falling back to the end of the buffer. */
  const renderSince = (baseline: Baseline, contents: string, maxLines: number): string => {
    const fresh = newOutputSince(baseline, contents);
    const rendered = renderOutput(limitOutput(fresh.lines, maxLines));
    if (fresh.exact) return rendered;
    return (
      "[Could not tell where the new output starts (the screen was probably cleared or scrolled past the " +
      `scrollback limit); showing the end of the session instead.]\n${rendered}`
    );
  };

  const describeWait = (result: WaitResult, timeoutMs: number, pattern: string | undefined): string => {
    const stillRunning = result.job?.busy ? ` Still running: ${describeJob(result.job)}.` : "";
    switch (result.outcome) {
      case "finished":
        return "Finished.";
      case "matched":
        return `Output matched /${pattern}/: ${JSON.stringify(result.match)}.${stillRunning}`;
      case "cancelled":
        return `Stopped waiting because the request was cancelled.${stillRunning}`;
      case "timeout":
        if (!result.job?.busy) {
          return `Gave up after ${formatDuration(timeoutMs)}: the output was still changing. Use read_output to check on it.`;
        }
        return (
          `Still running after ${formatDuration(timeoutMs)}: ${describeJob(result.job)}. ` +
          'Use wait_for_output to keep waiting, read_output to check on it, or send_keys ["ctrl+c"] to stop it.'
        );
    }
  };

  // Failures come back as readable tool errors rather than protocol errors.
  const safely = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };
  const handler =
    <A>(fn: (args: A, extra: Extra) => Promise<CallToolResult>) =>
    (args: A, extra: Extra): Promise<CallToolResult> =>
      safely(() => fn(args, extra));

  server.registerTool(
    "list_sessions",
    {
      title: "List iTerm2 sessions",
      description:
        "List every iTerm2 window, tab and split pane (session) with its session_id, name, tty, working directory, " +
        "size, whether it is focused, and whether it is idle at a shell prompt or running a program. " +
        "is_self marks the terminal this assistant itself runs in (never type into that one).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      safely(async () => {
        const list = await iterm.listSessions();
        if (!list.running) return textResult("iTerm2 is not running. Use create_window to start it.");
        const [self, processes] = await Promise.all([getSelf(), deps.processes().catch(() => null)]);
        const sessions = list.sessions.map((session) =>
          summarize(session, self, processes ? jobStateForTty(processes, session.tty) : null),
        );
        return textResult(JSON.stringify({ sessions }, null, 2));
      }),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a shell command",
      description:
        "Type a shell command into an iTerm2 session, press Enter, and return the output it produces. Waits until " +
        "the command finishes (only the shell left in the foreground and the output settled), until the output " +
        "matches wait_for, or until timeout_seconds pass; on timeout the command keeps running. Refuses when the " +
        "session is busy with another program (use send_text / send_keys for those). The output is read off the " +
        'screen, so it starts with the prompt line and does not include an exit code; append `; echo "exit=$?"` ' +
        "if you need one.",
      inputSchema: {
        command: z.string().min(1).describe("The command line to type, exactly as you would type it at the prompt."),
        session_id: sessionIdField,
        timeout_seconds: z
          .number()
          .min(1)
          .max(600)
          .default(30)
          .describe("How long to wait for the command to finish before returning the output so far."),
        wait_for: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Regular expression. Return as soon as the command's output matches it, even while it keeps running " +
              "(e.g. 'ready|listening on' for a dev server).",
          ),
        max_lines: z.number().int().min(1).max(10_000).default(200).describe("Return at most this many output lines (the last ones)."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ command, session_id, timeout_seconds, wait_for, max_lines }, extra) => {
      const pattern = wait_for === undefined ? undefined : compilePattern(wait_for, false);
      const session = await writableSession(session_id);
      const job = await jobState(session.tty);
      if (job?.busy) {
        throw new ToolError(
          `Session ${session.id} is busy running ${describeJob(job)}, so the command would be typed into that ` +
            "program rather than the shell. Use send_text / send_keys to interact with it, wait_for_output to wait " +
            'for it to finish, send_keys ["ctrl+c"] to stop it, or create_tab / split_pane for a fresh shell.',
        );
      }
      const before = await iterm.snapshot(session.id);
      const baseline = captureBaseline(before.contents);
      baselines.set(session.id, baseline);
      await iterm.write(session.id, command, true);

      const timeoutMs = timeout_seconds * 1000;
      const result = await waitForCommand(waitContext(extra), {
        sessionId: session.id,
        tty: session.tty,
        timeoutMs,
        baseline,
        pattern,
        useShellIntegration: before.atShellPrompt === true,
      });
      return textResult(
        `${describeWait(result, timeoutMs, wait_for)}\nSession: ${label(session)}\n\n` +
          renderSince(baseline, result.contents, max_lines),
      );
    }),
  );

  server.registerTool(
    "send_text",
    {
      title: "Type text",
      description:
        "Type text into an iTerm2 session, optionally followed by Enter, without waiting for a command to finish. " +
        "Use it to answer prompts, drive REPLs (python, node, psql), work in a remote shell over ssh, or type into " +
        "any program that is already running. Returns what appeared on screen once the output settles (waiting up " +
        "to wait_seconds).",
      inputSchema: {
        text: z.string().describe("Text to type. Newlines are sent as typed."),
        session_id: sessionIdField,
        press_enter: z.boolean().default(true).describe("Press Enter after the text."),
        wait_seconds: z
          .number()
          .min(0)
          .max(60)
          .default(5)
          .describe("Longest time to wait for the output to settle before returning it. 0 returns immediately without output."),
        max_lines: z.number().int().min(1).max(10_000).default(100).describe("Return at most this many output lines (the last ones)."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ text, session_id, press_enter, wait_seconds, max_lines }, extra) => {
      const session = await writableSession(session_id);
      return sendInput(session, text, press_enter, wait_seconds, max_lines, extra);
    }),
  );

  server.registerTool(
    "send_keys",
    {
      title: "Press keys",
      description:
        "Press special keys in an iTerm2 session, in order: Ctrl-C to interrupt, Ctrl-D for end of input, Escape, " +
        `Tab completion, arrow keys, and so on. ${KEY_HELP} Returns what appeared on screen once the output settles.`,
      inputSchema: {
        keys: z
          .array(z.string().min(1))
          .min(1)
          .max(200)
          .describe('Keys to press in order, e.g. ["ctrl+c"], ["escape", ":", "w", "q", "enter"] or ["up", "enter"].'),
        session_id: sessionIdField,
        wait_seconds: z
          .number()
          .min(0)
          .max(60)
          .default(3)
          .describe("Longest time to wait for the output to settle before returning it. 0 returns immediately without output."),
        max_lines: z.number().int().min(1).max(10_000).default(100).describe("Return at most this many output lines (the last ones)."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ keys, session_id, wait_seconds, max_lines }, extra) => {
      let text: string;
      try {
        text = keysToText(keys);
      } catch (error) {
        throw new ToolError((error as Error).message);
      }
      const session = await writableSession(session_id);
      return sendInput(session, text, false, wait_seconds, max_lines, extra);
    }),
  );

  async function sendInput(
    session: SessionInfo,
    text: string,
    pressEnter: boolean,
    waitSeconds: number,
    maxLines: number,
    extra: Extra,
  ): Promise<CallToolResult> {
    const before = await iterm.snapshot(session.id);
    const baseline = captureBaseline(before.contents);
    baselines.set(session.id, baseline);
    await iterm.write(session.id, text, pressEnter);
    if (waitSeconds === 0) return textResult(`Sent to ${label(session)}.`);
    const contents = await waitForQuiet(waitContext(extra), session.id, waitSeconds * 1000);
    return textResult(`Sent to ${label(session)}. Screen output since then:\n\n${renderSince(baseline, contents, maxLines)}`);
  }

  server.registerTool(
    "read_output",
    {
      title: "Read session output",
      description:
        "Read the last lines of an iTerm2 session (scrollback included), along with whether it is idle at a shell " +
        "prompt or running a program. Does not type anything.",
      inputSchema: {
        session_id: sessionIdField,
        lines: z.number().int().min(1).max(10_000).default(100).describe("How many lines to return, counting from the end."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async ({ session_id, lines }) => {
      const session = await iterm.getSession(session_id);
      const [snapshot, job, self] = await Promise.all([iterm.snapshot(session.id), jobState(session.tty), getSelf()]);
      const own = isSelf(session, self) ? " (this is the terminal you are running in)" : "";
      return textResult(
        `Session: ${label(session)}${own}\nStatus: ${jobText(job)}\n\n` +
          renderOutput(limitOutput(toLines(snapshot.contents), lines)),
      );
    }),
  );

  server.registerTool(
    "wait_for_output",
    {
      title: "Wait for output",
      description:
        "Wait until an iTerm2 session's output matches pattern (a JavaScript regular expression) or, without a " +
        "pattern, until the program running in it finishes. Only output that appeared after the last input sent " +
        "through these tools counts (or after this call, if nothing was sent yet), and that output is returned.",
      inputSchema: {
        session_id: sessionIdField,
        pattern: z.string().min(1).optional().describe("Regular expression to wait for. Omit to wait for the running command to finish."),
        ignore_case: z.boolean().default(false).describe("Match pattern case-insensitively."),
        timeout_seconds: z.number().min(1).max(600).default(30).describe("Give up after this many seconds."),
        max_lines: z.number().int().min(1).max(10_000).default(200).describe("Return at most this many output lines (the last ones)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async ({ session_id, pattern, ignore_case, timeout_seconds, max_lines }, extra) => {
      const regex = pattern === undefined ? undefined : compilePattern(pattern, ignore_case);
      const session = await iterm.getSession(session_id);
      const baseline = baselines.get(session.id) ?? captureBaseline((await iterm.snapshot(session.id)).contents);
      const timeoutMs = timeout_seconds * 1000;
      const result = await waitForCommand(waitContext(extra), {
        sessionId: session.id,
        tty: session.tty,
        timeoutMs,
        baseline,
        pattern: regex,
      });
      return textResult(
        `${describeWait(result, timeoutMs, pattern)}\nSession: ${label(session)}\n\n` +
          renderSince(baseline, result.contents, max_lines),
      );
    }),
  );

  const profileField = z.string().min(1).optional().describe("iTerm2 profile name to use instead of the default profile.");
  const nameField = z.string().min(1).optional().describe("Name to give the new session, shown in its tab title.");

  server.registerTool(
    "create_tab",
    {
      title: "Open a new tab",
      description:
        "Open a new iTerm2 tab running a fresh shell and return its session. Uses the focused window unless " +
        "window_id is given, and opens a window if there is none. Waits for the shell prompt before returning.",
      inputSchema: {
        window_id: z.number().int().optional().describe("Window to add the tab to (window_id from list_sessions)."),
        profile: profileField,
        name: nameField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ window_id, profile, name }, extra) => {
      const session = await iterm.createTab({ windowId: window_id, profile, name });
      return describeNewSession(session, "Opened a new tab.", extra);
    }),
  );

  server.registerTool(
    "create_window",
    {
      title: "Open a new window",
      description:
        "Open a new iTerm2 window running a fresh shell and return its session. Starts iTerm2 if it is not running. " +
        "Waits for the shell prompt before returning.",
      inputSchema: { profile: profileField, name: nameField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ profile, name }, extra) => {
      const session = await iterm.createWindow({ profile, name });
      return describeNewSession(session, "Opened a new window.", extra);
    }),
  );

  server.registerTool(
    "split_pane",
    {
      title: "Split a pane",
      description:
        "Split an iTerm2 session into two panes and return the new pane's session, running a fresh shell. " +
        '"vertical" puts the new pane to the right, "horizontal" puts it below. Splitting your own terminal is ' +
        "allowed and lets the user watch your commands next to the conversation. Waits for the shell prompt.",
      inputSchema: {
        session_id: sessionIdField,
        direction: z
          .enum(["vertical", "horizontal"])
          .default("vertical")
          .describe("vertical: side by side, new pane on the right. horizontal: stacked, new pane below."),
        profile: profileField,
        name: nameField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ session_id, direction, profile, name }, extra) => {
      const source = await iterm.getSession(session_id);
      const session = await iterm.splitPane(source.id, { vertical: direction === "vertical", profile, name });
      const how = direction === "vertical" ? "side by side" : "top and bottom";
      return describeNewSession(session, `Split ${label(source)} ${how}.`, extra);
    }),
  );

  server.registerTool(
    "focus_session",
    {
      title: "Focus a session",
      description: "Bring an iTerm2 session to the front: activates iTerm2 and selects the session's window, tab and pane.",
      inputSchema: { session_id: z.string().min(1).describe("Session to focus.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ session_id }) => {
      await iterm.focus(session_id);
      return textResult(`Focused session ${session_id}.`);
    }),
  );

  server.registerTool(
    "close_session",
    {
      title: "Close a session",
      description:
        "Close an iTerm2 session (its pane, or its tab if it is the only pane). Refuses while a program is running " +
        "in it unless force is true, and never closes the terminal this assistant runs in.",
      inputSchema: {
        session_id: z.string().min(1).describe("Session to close."),
        force: z.boolean().default(false).describe("Close even if a program is still running in the session."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ session_id, force }) => {
      const session = await writableSession(session_id);
      const job = await jobState(session.tty);
      if (job?.busy && !force) {
        throw new ToolError(
          `Session ${session.id} is still running ${describeJob(job)}. Stop it first (send_keys ["ctrl+c"]) or pass force: true.`,
        );
      }
      await iterm.close(session.id);
      baselines.delete(session.id);
      await clock.sleep(timing.pollMs);
      const stillOpen = await iterm.getSession(session.id).then(
        () => true,
        () => false,
      );
      return textResult(
        stillOpen
          ? `Asked iTerm2 to close session ${session.id}, but it is still open; iTerm2 may be asking the user to confirm.`
          : `Closed session ${session.id}.`,
      );
    }),
  );

  return server;
}
