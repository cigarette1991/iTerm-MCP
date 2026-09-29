import { execFile } from "node:child_process";

/**
 * Figures out what a terminal is doing by looking at the processes attached to
 * its tty. The foreground process group of a tty is the job that receives
 * keyboard input: when it is just the interactive shell, the session is
 * sitting at a prompt; otherwise a command is running.
 */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Process group id. */
  pgid: number;
  /** Foreground process group of the controlling terminal (0 or -1 when none). */
  tpgid: number;
  stat: string;
  /** Controlling terminal as printed by ps: "ttys004" on macOS, "pts/3" on Linux, "??" when none. */
  tty: string;
  /** Command line. */
  args: string;
}

export interface JobState {
  /** False when no process on the tty could be seen, so the state is unknown. */
  known: boolean;
  /** True while something other than an interactive shell holds the foreground. */
  busy: boolean;
  /** Foreground processes that are not the interactive shell. */
  running: ProcessInfo[];
}

export type ProcessLister = () => Promise<ProcessInfo[]>;

const PS_FORMAT = "pid=,ppid=,pgid=,tpgid=,stat=,tty=,args=";
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s?(.*)$/;

export function parsePsOutput(stdout: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      stat: match[5],
      tty: match[6],
      args: match[7].trim(),
    });
  }
  return processes;
}

/** Lists every process on the machine with the fields needed for job control. */
export const listProcesses: ProcessLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-ww", "-o", PS_FORMAT],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parsePsOutput(stdout));
      },
    );
  });

/**
 * Normalises the different spellings of a terminal device so they compare
 * equal: "/dev/ttys004", "ttys004" and "s004" all become "s004".
 * Returns "" for "no terminal" markers such as "??" or "?".
 */
export function normalizeTty(tty: string): string {
  let name = tty.trim();
  if (name === "" || /^\?+$/.test(name) || name === "-") return "";
  if (name.startsWith("/dev/")) name = name.slice("/dev/".length);
  if (name.startsWith("tty") && name.length > 3) name = name.slice(3);
  return name;
}

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "mksh",
  "oksh",
  "pdksh",
  "tcsh",
  "csh",
  "yash",
  "elvish",
  "nu",
  "xonsh",
  "pwsh",
  "ion",
]);

/**
 * True when a command line looks like an interactive shell waiting at its
 * prompt ("-zsh", "/bin/bash --login", "fish -i"), as opposed to a shell
 * running a script ("bash build.sh", "sh -c 'make'").
 */
export function isInteractiveShell(args: string): boolean {
  const words = args.trim().split(/\s+/);
  const program = (words[0] ?? "").replace(/^-/, "").split("/").pop() ?? "";
  if (!SHELLS.has(program)) return false;
  for (const word of words.slice(1)) {
    // A -c flag (possibly bundled, as in -lc) means "run this command string".
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) return false;
    // Any operand that is not an option is a script to run.
    if (!word.startsWith("-") && !word.startsWith("+")) return false;
  }
  return true;
}

export function jobStateForTty(processes: ProcessInfo[], tty: string): JobState {
  const target = normalizeTty(tty);
  const onTty = target === "" ? [] : processes.filter((p) => normalizeTty(p.tty) === target);
  if (onTty.length === 0) {
    return { known: false, busy: false, running: [] };
  }
  let foreground = onTty.filter((p) => p.tpgid > 0 && p.pgid === p.tpgid);
  if (foreground.length === 0) {
    // Fall back to ps's "+" flag, which marks the foreground process group.
    foreground = onTty.filter((p) => p.stat.includes("+"));
  }
  const running = foreground.filter((p) => !isInteractiveShell(p.args)).sort((a, b) => a.pid - b.pid);
  return { known: true, busy: running.length > 0, running };
}

/** Short human-readable description of what a busy session is running. */
export function describeJob(state: JobState): string {
  if (!state.busy) return "idle";
  const commands = state.running.slice(0, 3).map((p) => (p.args.length > 80 ? `${p.args.slice(0, 77)}...` : p.args));
  const more = state.running.length > 3 ? ` (+${state.running.length - 3} more)` : "";
  return commands.join("; ") + more;
}

/**
 * Finds the terminal a process is attached to, walking up through its parents
 * because the MCP server itself usually talks over pipes.
 */
export function controllingTty(processes: ProcessInfo[], pid: number): string | null {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  let current = byPid.get(pid);
  for (let hops = 0; current && hops < 32; hops++) {
    const tty = normalizeTty(current.tty);
    if (tty !== "") return tty;
    if (current.ppid === current.pid) break;
    current = byPid.get(current.ppid);
  }
  return null;
}
