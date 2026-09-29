import { ITermError, type CreateOptions, type ITermBackend, type SessionInfo, type SessionList, type Snapshot } from "../../src/iterm.js";
import type { ProcessInfo } from "../../src/processes.js";

/**
 * A pretend iTerm2 full of pretend shells, for testing the MCP tools without a
 * Mac. Each session keeps a list of screen lines and understands a handful of
 * commands; `processes()` reports what a real `ps` would show for them.
 */

export const PROMPT = "~ %";

let nextPid = 5000;
let nextSession = 1;

interface Program {
  args: string;
  pid: number;
  onInput: (text: string) => void;
}

export class FakeShell {
  lines: string[];
  program: Program | null = null;
  readonly shellPid = nextPid++;
  readonly loginPid = nextPid++;
  /** Set to false to simulate a shell that has not printed its first prompt yet. */
  started = true;

  constructor(
    readonly terminal: FakeTerminal,
    public info: SessionInfo,
  ) {
    this.lines = ["Last login: Tue Sep 29 on ttys000", `${PROMPT} `];
  }

  get contents(): string {
    // Like iTerm2, include the empty rows below the cursor.
    return this.started ? `${this.lines.join("\n")}\n\n\n\n` : "\n\n\n";
  }

  print(...lines: string[]): void {
    this.lines.push(...lines);
  }

  append(text: string): void {
    this.lines[this.lines.length - 1] += text;
  }

  prompt(): void {
    this.program = null;
    this.lines.push(`${PROMPT} `);
  }

  run(args: string, onInput: (text: string) => void = () => {}): Program {
    this.program = { args, pid: nextPid++, onInput };
    return this.program;
  }

  /** Handles a line typed at the shell prompt. */
  execute(line: string): void {
    const [command, ...rest] = line.trim().split(/\s+/);
    const argument = rest.join(" ");
    switch (command) {
      case "":
        this.prompt();
        return;
      case "echo":
        this.print(argument);
        this.prompt();
        return;
      case "clear":
        this.lines = [];
        this.prompt();
        return;
      case "slow": {
        // slow <ms>: runs quietly for a while, then reports.
        const program = this.run(`slow ${argument}`);
        setTimeout(() => {
          if (this.program !== program) return;
          this.print("slow done");
          this.prompt();
        }, Number(argument));
        return;
      }
      case "server": {
        // A dev server: prints a banner after a moment and runs until Ctrl-C.
        const program = this.run("node server.js", (text) => {
          if (text.includes("\x03")) {
            this.print("^C");
            this.prompt();
          }
        });
        setTimeout(() => {
          if (this.program === program) this.print("listening on 3000");
        }, 30);
        return;
      }
      case "python3": {
        this.print("Python 3.12.0", ">>> ");
        this.run("python3", (text) => {
          const input = text.replace(/\r$/, "");
          this.append(input);
          if (input === "exit()") {
            this.prompt();
          } else {
            if (input === "1+1") this.print("2");
            this.print(">>> ");
          }
        });
        return;
      }
      default:
        this.print(`zsh: command not found: ${command}`);
        this.prompt();
    }
  }

  processes(): ProcessInfo[] {
    const tty = this.info.tty.replace("/dev/", "");
    const foreground = this.program ? this.program.pid : this.shellPid;
    const login = "/usr/bin/login -fpl me /Applications/iTerm.app/Contents/MacOS/ShellLauncher --launch_shell";
    const rows: ProcessInfo[] = [
      { pid: this.loginPid, ppid: 1, pgid: this.loginPid, tpgid: foreground, stat: "Ss", tty, args: login },
      { pid: this.shellPid, ppid: this.loginPid, pgid: this.shellPid, tpgid: foreground, stat: "S", tty, args: "-zsh" },
    ];
    if (this.program) {
      rows.push({ pid: this.program.pid, ppid: this.shellPid, pgid: this.program.pid, tpgid: foreground, stat: "S+", tty, args: this.program.args });
    }
    return this.started ? rows : rows.slice(0, 1);
  }
}

export class FakeTerminal implements ITermBackend {
  readonly shells = new Map<string, FakeShell>();
  readonly writes: Array<{ id: string; text: string; newline: boolean }> = [];
  readonly closed: string[] = [];
  focusedId: string | null = null;
  running = true;
  /** How long new sessions take to show their first prompt. */
  startupMs = 20;
  /** Sessions that ignore close requests, like iTerm2 waiting for the user to confirm. */
  readonly stubborn = new Set<string>();

  addShell(overrides: Partial<SessionInfo> = {}): FakeShell {
    const n = nextSession++;
    const info: SessionInfo = {
      id: `SESSION-${n}`,
      name: `zsh ${n}`,
      tty: `/dev/ttys${String(100 + n).padStart(3, "0")}`,
      profile: "Default",
      columns: 120,
      rows: 40,
      cwd: "/Users/me/project",
      windowId: 1,
      windowIndex: 0,
      tabIndex: this.shells.size,
      paneIndex: 0,
      isActiveInTab: true,
      isCurrent: false,
      ...overrides,
    };
    const shell = new FakeShell(this, info);
    this.shells.set(info.id, shell);
    this.focusedId ??= info.id;
    return shell;
  }

  shell(id: string): FakeShell {
    const shell = this.shells.get(id);
    if (!shell) throw new ITermError(`No iTerm2 session has id ${id}. Call list_sessions to see the open sessions.`, "SESSION_NOT_FOUND");
    return shell;
  }

  private infoOf(shell: FakeShell): SessionInfo {
    return { ...shell.info, isCurrent: shell.info.id === this.focusedId };
  }

  processes = async (): Promise<ProcessInfo[]> => [...this.shells.values()].flatMap((shell) => shell.processes());

  async listSessions(): Promise<SessionList> {
    if (!this.running) return { running: false, currentSessionId: null, sessions: [] };
    return { running: true, currentSessionId: this.focusedId, sessions: [...this.shells.values()].map((s) => this.infoOf(s)) };
  }

  async getSession(id?: string): Promise<SessionInfo> {
    const target = id ?? this.focusedId;
    if (!target) throw new ITermError("iTerm2 has no open windows. Use create_window to open one.", "NO_SESSION");
    return this.infoOf(this.shell(target));
  }

  async snapshot(id: string): Promise<Snapshot> {
    return { contents: this.shell(id).contents, atShellPrompt: null };
  }

  async write(id: string, text: string, newline: boolean): Promise<void> {
    this.writes.push({ id, text, newline });
    const shell = this.shell(id);
    if (shell.program) {
      shell.program.onInput(text + (newline ? "\r" : ""));
      return;
    }
    if (text.includes("\x03")) {
      shell.append("^C");
      shell.prompt();
      return;
    }
    shell.append(text);
    if (newline) shell.execute(text);
  }

  private startNew(overrides: Partial<SessionInfo>, options: CreateOptions): SessionInfo {
    const shell = this.addShell({ ...overrides, ...(options.name ? { name: options.name } : {}), ...(options.profile ? { profile: options.profile } : {}) });
    shell.started = false;
    setTimeout(() => (shell.started = true), this.startupMs);
    this.focusedId = shell.info.id;
    return this.infoOf(shell);
  }

  async createWindow(options: CreateOptions): Promise<SessionInfo> {
    return this.startNew({ windowId: 2, tabIndex: 0 }, options);
  }

  async createTab(options: CreateOptions & { windowId?: number }): Promise<SessionInfo> {
    return this.startNew({ windowId: options.windowId ?? 1 }, options);
  }

  async splitPane(id: string, options: CreateOptions & { vertical: boolean }): Promise<SessionInfo> {
    const source = this.shell(id);
    return this.startNew({ windowId: source.info.windowId, tabIndex: source.info.tabIndex, paneIndex: source.info.paneIndex + 1 }, options);
  }

  async focus(id: string): Promise<void> {
    this.shell(id);
    this.focusedId = id;
  }

  async close(id: string): Promise<void> {
    this.shell(id);
    this.closed.push(id);
    if (!this.stubborn.has(id)) this.shells.delete(id);
  }
}
