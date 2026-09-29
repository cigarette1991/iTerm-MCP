import { execFile } from "node:child_process";
import { JXA_SOURCE } from "./jxa.js";

export interface SessionInfo {
  /** iTerm2's unique session id (a UUID, the same one found in $ITERM_SESSION_ID). */
  id: string;
  name: string;
  /** Device path such as /dev/ttys004. */
  tty: string;
  profile: string | null;
  columns: number | null;
  rows: number | null;
  /** Working directory as iTerm2 knows it, when available. */
  cwd: string | null;
  windowId: number | null;
  windowIndex: number;
  tabIndex: number;
  paneIndex: number;
  /** Whether this is the selected pane of its tab. */
  isActiveInTab: boolean;
  /** Whether this is the focused session of the frontmost iTerm2 window. */
  isCurrent: boolean;
}

export interface SessionList {
  running: boolean;
  currentSessionId: string | null;
  sessions: SessionInfo[];
}

export interface Snapshot {
  /** Full text of the session: scrollback plus screen. */
  contents: string;
  /** iTerm2's shell-integration prompt flag; always false without shell integration. */
  atShellPrompt: boolean | null;
}

export interface CreateOptions {
  profile?: string;
  name?: string;
}

/** Everything the MCP tools need from iTerm2. */
export interface ITermBackend {
  listSessions(): Promise<SessionList>;
  /** Looks up a session, or the focused session when id is omitted. */
  getSession(id?: string): Promise<SessionInfo>;
  snapshot(id: string): Promise<Snapshot>;
  write(id: string, text: string, newline: boolean): Promise<void>;
  createWindow(options: CreateOptions): Promise<SessionInfo>;
  createTab(options: CreateOptions & { windowId?: number }): Promise<SessionInfo>;
  splitPane(id: string, options: CreateOptions & { vertical: boolean }): Promise<SessionInfo>;
  focus(id: string): Promise<void>;
  close(id: string): Promise<void>;
}

export class ITermError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ITermError";
  }
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export const execFileAsync: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

const AUTOMATION_HELP =
  "macOS did not allow this process to control iTerm2. Open System Settings → Privacy & Security → Automation, " +
  "find the app that launched this MCP server (your terminal, Claude, or your editor) and enable iTerm2 under it, " +
  "then try again.";

/** Turns an Apple Event error number (and message) into advice a user can act on. */
export function explainAppleEventError(errorNumber: number | null, message: string): ITermError {
  if (errorNumber === -1743 || /not authori[sz]ed to send apple events/i.test(message)) {
    return new ITermError(AUTOMATION_HELP, "NOT_AUTHORIZED");
  }
  if (errorNumber === -600 || /application isn.t running/i.test(message)) {
    return new ITermError("iTerm2 is not running. Use create_window to start it.", "NOT_RUNNING");
  }
  if (/application can.t be found/i.test(message)) {
    return new ITermError("iTerm2 is not installed (bundle id com.googlecode.iterm2 was not found). Get it from https://iterm2.com.", "NOT_INSTALLED");
  }
  if (errorNumber === -1712 || /timed out/i.test(message)) {
    return new ITermError("iTerm2 did not respond in time. It may be showing a dialog that needs your attention.", "TIMEOUT");
  }
  return new ITermError(`iTerm2 reported an error: ${message}`, "APPLE_EVENT_ERROR");
}

function parseErrorNumber(text: string): number | null {
  const match = /\((-?\d+)\)\s*$/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** Talks to iTerm2 by running the JXA bridge script through `osascript`. */
export class OsascriptITerm implements ITermBackend {
  constructor(
    private readonly exec: ExecFileFn = execFileAsync,
    private readonly timeoutMs = 30_000,
  ) {}

  /** Sends one request to the JXA bridge and returns its result. */
  async call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec("osascript", ["-l", "JavaScript", "-e", JXA_SOURCE, JSON.stringify({ op, ...params })], {
        timeout: this.timeoutMs,
        // Scrollback can be large; allow up to 256 MB of text.
        maxBuffer: 256 * 1024 * 1024,
      }));
    } catch (error) {
      throw this.translateExecError(error);
    }

    let reply: { ok: boolean; result?: T; code?: string; error?: string; errorNumber?: number | null };
    try {
      reply = JSON.parse(stdout.trim());
    } catch {
      throw new ITermError(`Unexpected reply from osascript: ${stdout.trim().slice(0, 500)}`, "BAD_REPLY");
    }
    if (reply.ok) {
      return reply.result as T;
    }
    if (reply.code === "APPLE_EVENT_ERROR") {
      throw explainAppleEventError(reply.errorNumber ?? null, reply.error ?? "unknown error");
    }
    throw new ITermError(reply.error ?? "Unknown error from iTerm2.", reply.code ?? "ITERM_ERROR");
  }

  private translateExecError(error: unknown): ITermError {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
    if (err.code === "ENOENT") {
      return new ITermError("osascript was not found. This MCP server only works on macOS.", "NO_OSASCRIPT");
    }
    if (err.killed || err.signal === "SIGTERM") {
      return new ITermError(
        `iTerm2 did not respond within ${Math.round(this.timeoutMs / 1000)}s. It may be showing a dialog that needs your attention.`,
        "TIMEOUT",
      );
    }
    const stderr = (err.stderr ?? "").trim() || String(err.message ?? err);
    return explainAppleEventError(parseErrorNumber(stderr), stderr);
  }

  listSessions(): Promise<SessionList> {
    return this.call("list");
  }

  getSession(id?: string): Promise<SessionInfo> {
    return this.call("get", { id: id ?? null });
  }

  snapshot(id: string): Promise<Snapshot> {
    return this.call("snapshot", { id });
  }

  async write(id: string, text: string, newline: boolean): Promise<void> {
    await this.call("write", { id, text, newline });
  }

  createWindow(options: CreateOptions): Promise<SessionInfo> {
    return this.call("createWindow", { ...options });
  }

  createTab(options: CreateOptions & { windowId?: number }): Promise<SessionInfo> {
    return this.call("createTab", { ...options });
  }

  splitPane(id: string, options: CreateOptions & { vertical: boolean }): Promise<SessionInfo> {
    return this.call("split", { id, ...options });
  }

  async focus(id: string): Promise<void> {
    await this.call("focus", { id });
  }

  async close(id: string): Promise<void> {
    await this.call("close", { id });
  }
}
