import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  controllingTty,
  describeJob,
  isInteractiveShell,
  jobStateForTty,
  listProcesses,
  normalizeTty,
  parsePsOutput,
} from "../src/processes.js";

// Shaped like `ps -A -ww -o pid=,ppid=,pgid=,tpgid=,stat=,tty=,args=` on macOS.
const MAC_PS = `
    1     0     1     0 Ss   ??       /sbin/launchd
  500     1   500     0 S    ??       /Applications/iTerm.app/Contents/MacOS/iTerm2
  601   500   601   602 Ss   ttys001  /usr/bin/login -fpl me /Applications/iTerm.app/Contents/MacOS/ShellLauncher --launch_shell
  602   601   602   602 S+   ttys001  -zsh
  701   500   701   720 Ss   ttys002  /usr/bin/login -fpl me /Applications/iTerm.app/Contents/MacOS/ShellLauncher --launch_shell
  702   701   702   720 S    ttys002  -zsh
  720   702   720   720 S+   ttys002  npm run dev
  721   720   720   720 S+   ttys002  node /Users/me/app/node_modules/.bin/next dev
  801   500   801   802 Ss   ttys003  /usr/bin/login -fpl me /Applications/iTerm.app/Contents/MacOS/ShellLauncher --launch_shell
  802   801   802   802 S+   ttys003  -zsh
  900   802   900   802 S    ttys003  sleep 1000
  950   702   950   720 S    ttys002  claude
  951   950   951   720 S    ttys002  node /opt/iterm2-mcp/dist/index.js
`;

describe("parsePsOutput", () => {
  it("parses every row including command lines with spaces", () => {
    const processes = parsePsOutput(MAC_PS);
    expect(processes).toHaveLength(13);
    expect(processes[2]).toEqual({
      pid: 601,
      ppid: 500,
      pgid: 601,
      tpgid: 602,
      stat: "Ss",
      tty: "ttys001",
      args: "/usr/bin/login -fpl me /Applications/iTerm.app/Contents/MacOS/ShellLauncher --launch_shell",
    });
  });

  it("accepts Linux-style negative tpgid and empty args", () => {
    expect(parsePsOutput("    2     0     0    -1 S    ?        \n")).toEqual([
      { pid: 2, ppid: 0, pgid: 0, tpgid: -1, stat: "S", tty: "?", args: "" },
    ]);
  });
});

describe("normalizeTty", () => {
  it("treats all spellings of a terminal the same", () => {
    expect(normalizeTty("/dev/ttys004")).toBe("s004");
    expect(normalizeTty("ttys004")).toBe("s004");
    expect(normalizeTty("s004")).toBe("s004");
    expect(normalizeTty("/dev/pts/3")).toBe("pts/3");
    expect(normalizeTty("??")).toBe("");
    expect(normalizeTty("?")).toBe("");
  });
});

describe("isInteractiveShell", () => {
  it.each(["-zsh", "zsh", "/bin/bash --login", "-bash", "fish -i", "/opt/homebrew/bin/fish", "zsh -l"])("%s is a prompt", (args) => {
    expect(isInteractiveShell(args)).toBe(true);
  });

  it.each(["bash build.sh", "sh -c make", "zsh -lc 'npm test'", "node server.js", "vim", "python3", "login -fpl me"])(
    "%s is a running command",
    (args) => {
      expect(isInteractiveShell(args)).toBe(false);
    },
  );
});

describe("jobStateForTty", () => {
  const processes = parsePsOutput(MAC_PS);

  it("sees a shell waiting at its prompt as idle", () => {
    expect(jobStateForTty(processes, "/dev/ttys001")).toEqual({ known: true, busy: false, running: [] });
  });

  it("sees a foreground job as busy", () => {
    const state = jobStateForTty(processes, "/dev/ttys002");
    expect(state.busy).toBe(true);
    expect(state.running.map((p) => p.pid)).toEqual([720, 721]);
    expect(describeJob(state)).toBe("npm run dev; node /Users/me/app/node_modules/.bin/next dev");
  });

  it("ignores background jobs", () => {
    expect(jobStateForTty(processes, "/dev/ttys003").busy).toBe(false);
  });

  it("reports an unknown state for a terminal it cannot see", () => {
    expect(jobStateForTty(processes, "/dev/ttys099")).toEqual({ known: false, busy: false, running: [] });
  });

  it("falls back to the + flag when tpgid is unavailable", () => {
    const rows = parsePsOutput(`
  10     1    10     0 Ss   ttys005  -zsh
  11    10    11     0 S+   ttys005  top
`);
    expect(jobStateForTty(rows, "/dev/ttys005").running.map((p) => p.args)).toEqual(["top"]);
  });
});

describe("controllingTty", () => {
  it("walks up to the first ancestor with a terminal", () => {
    const processes = parsePsOutput(MAC_PS).map((p) => (p.pid === 951 ? { ...p, tty: "??" } : p));
    expect(controllingTty(processes, 951)).toBe("s002");
    expect(controllingTty(processes, 500)).toBeNull();
    expect(controllingTty(processes, 123456)).toBeNull();
  });
});

// Exercises the real `ps` against a real pseudo-terminal, as on an iTerm2 session.
describe.runIf(process.platform === "linux" || process.platform === "darwin")("with a real terminal", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const value = await probe();
      if (value !== undefined) return value;
      await sleep(50);
    }
    throw new Error("condition not reached");
  }

  it("tells an idle shell from a running command", async () => {
    // `script` gives bash a pty of its own. Its flags differ between util-linux and BSD.
    const shell = "bash --norc --noprofile -i";
    const args = process.platform === "darwin" ? ["-q", "/dev/null", ...shell.split(" ")] : ["-qfc", shell, "/dev/null"];
    child = spawn("script", args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.resume();
    child.stderr?.resume();

    const tty = await waitFor(async () => {
      const processes = await listProcesses();
      const bash = processes.find((p) => p.args.startsWith(shell) && normalizeTty(p.tty) !== "");
      return bash ? bash.tty : undefined;
    });
    expect(tty).toMatch(process.platform === "darwin" ? /^ttys\d+$/ : /^pts\/\d+$/);

    const idle = await waitFor(async () => {
      const state = jobStateForTty(await listProcesses(), `/dev/${tty}`);
      return state.known && !state.busy ? state : undefined;
    });
    expect(idle.running).toEqual([]);

    child.stdin?.write("sleep 30\n");
    const busy = await waitFor(async () => {
      const state = jobStateForTty(await listProcesses(), `/dev/${tty}`);
      return state.busy ? state : undefined;
    });
    expect(describeJob(busy)).toBe("sleep 30");

    child.stdin?.write("\x03");
    await waitFor(async () => {
      const state = jobStateForTty(await listProcesses(), `/dev/${tty}`);
      return state.known && !state.busy ? state : undefined;
    });
  });

  it("finds the terminal of a process started inside it", async () => {
    const processes = await listProcesses();
    const own = processes.find((p) => p.pid === process.pid);
    expect(own).toBeDefined();
    // Test runners may or may not have a terminal; either way the lookup must not throw.
    const tty = controllingTty(processes, process.pid);
    expect(tty === null || tty.length > 0).toBe(true);
  });
});
