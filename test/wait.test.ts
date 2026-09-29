import { describe, expect, it } from "vitest";
import type { ITermBackend, Snapshot } from "../src/iterm.js";
import { captureBaseline } from "../src/output.js";
import type { ProcessInfo } from "../src/processes.js";
import { waitForCommand, waitForQuiet, waitForShellReady, type Clock, type Timing, type WaitContext } from "../src/wait.js";

const TIMING: Timing = { pollMs: 100, settleMs: 300, initialDelayMs: 100, promptGraceMs: 2000 };
const TTY = "/dev/ttys042";

/** Virtual time: sleeping advances the clock instantly. */
function virtualClock(): Clock & { time: number } {
  const clock = {
    time: 0,
    now: () => clock.time,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (!signal?.aborted) clock.time += ms;
    },
  };
  return clock;
}

function shellProcesses(running: string | null): ProcessInfo[] {
  const foreground = running ? 20 : 10;
  const rows: ProcessInfo[] = [{ pid: 10, ppid: 1, pgid: 10, tpgid: foreground, stat: "Ss", tty: "ttys042", args: "-zsh" }];
  if (running) rows.push({ pid: 20, ppid: 10, pgid: 20, tpgid: foreground, stat: "S+", tty: "ttys042", args: running });
  return rows;
}

/** A session whose screen, foreground job and prompt flag are functions of the (virtual) time. */
function scripted(
  clock: Clock & { time: number },
  screen: (t: number) => string,
  running: (t: number) => string | null,
  atPrompt: (t: number) => boolean | null = () => null,
): WaitContext & { snapshots: number } {
  const ctx = {
    snapshots: 0,
    clock,
    timing: TIMING,
    processes: async () => shellProcesses(running(clock.time)),
    iterm: {
      snapshot: async (): Promise<Snapshot> => {
        ctx.snapshots++;
        return { contents: screen(clock.time), atShellPrompt: atPrompt(clock.time) };
      },
    } as unknown as ITermBackend,
  };
  return ctx;
}

const BEFORE = "~ %";
const baseline = captureBaseline(BEFORE);
const options = { sessionId: "S", tty: TTY, baseline, timeoutMs: 10_000 };

describe("waitForCommand", () => {
  it("finishes once the job is gone and the screen has settled", async () => {
    const clock = virtualClock();
    const ctx = scripted(
      clock,
      (t) => (t < 1000 ? "~ % make" : "~ % make\nbuilt\n~ %"),
      (t) => (t < 1000 ? "make" : null),
    );
    const result = await waitForCommand(ctx, options);
    expect(result.outcome).toBe("finished");
    expect(result.contents).toBe("~ % make\nbuilt\n~ %");
    expect(clock.time).toBeGreaterThanOrEqual(1300);
    expect(clock.time).toBeLessThan(1600);
  });

  it("does not read the screen while the job is busy", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, () => "~ % sleep 5", (t) => (t < 5000 ? "sleep 5" : null));
    await waitForCommand(ctx, options);
    // Only the polls after the job ended read the screen.
    expect(ctx.snapshots).toBeLessThanOrEqual(5);
  });

  it("matches a pattern in the new output while the job keeps running", async () => {
    const clock = virtualClock();
    const ctx = scripted(
      clock,
      (t) => (t < 700 ? "~ % npm run dev" : "~ % npm run dev\n  ready in 312 ms"),
      () => "node vite",
    );
    const result = await waitForCommand(ctx, { ...options, pattern: /ready in \d+ ms/ });
    expect(result).toMatchObject({ outcome: "matched", match: "ready in 312 ms" });
    expect(result.job?.busy).toBe(true);
  });

  it("ignores pattern matches in old output", async () => {
    const clock = virtualClock();
    const history = "ready\n~ %";
    const ctx = scripted(clock, () => "ready\n~ % echo hi\nhi\n~ %", () => null);
    const result = await waitForCommand(ctx, { ...options, baseline: captureBaseline(history), pattern: /ready/ });
    expect(result.outcome).toBe("finished");
  });

  it("times out with a fresh screen and the running job", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, (t) => `~ % tail -f log\nline ${Math.floor(t / 1000)}`, () => "tail -f log");
    const result = await waitForCommand(ctx, { ...options, timeoutMs: 3000 });
    expect(result.outcome).toBe("timeout");
    expect(result.contents).toBe("~ % tail -f log\nline 3");
    expect(result.job?.running[0].args).toBe("tail -f log");
  });

  it("waits for the shell-integration prompt flag when it is in use", async () => {
    const clock = virtualClock();
    // A shell function: no child process, output only after 1.5s.
    const ctx = scripted(
      clock,
      (t) => (t < 1500 ? "~ % nvm use" : "~ % nvm use\nNow using node v22\n~ %"),
      () => null,
      (t) => t >= 1500,
    );
    const result = await waitForCommand(ctx, { ...options, useShellIntegration: true });
    expect(result.outcome).toBe("finished");
    expect(result.contents).toContain("Now using node v22");
  });

  it("stops waiting for the prompt flag after a long quiet period", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, () => "~ % bash\nbash-5.2$", () => null, () => false);
    const result = await waitForCommand(ctx, { ...options, useShellIntegration: true });
    expect(result.outcome).toBe("finished");
    expect(clock.time).toBeGreaterThanOrEqual(2000);
    expect(clock.time).toBeLessThan(3000);
  });

  it("keeps going on screen changes alone when ps fails", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, (t) => (t < 800 ? "~ % ls" : "~ % ls\na\n~ %"), () => null);
    ctx.processes = async () => {
      throw new Error("ps: not permitted");
    };
    const result = await waitForCommand(ctx, options);
    expect(result).toMatchObject({ outcome: "finished", job: null });
  });

  it("reports progress about once a second", async () => {
    const clock = virtualClock();
    const reports: number[] = [];
    const ctx = { ...scripted(clock, () => "~ % sleep 5", () => "sleep 5"), onProgress: (elapsed: number) => reports.push(elapsed) };
    await waitForCommand(ctx, { ...options, timeoutMs: 4500 });
    expect(reports).toEqual([1000, 2000, 3000, 4000]);
  });

  it("stops when the request is cancelled", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    const ctx = { ...scripted(clock, () => "~ % sleep 5", () => "sleep 5"), signal: controller.signal };
    const pending = waitForCommand(ctx, options);
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
  });
});

describe("waitForQuiet", () => {
  it("returns once the screen stops changing", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, (t) => `>>> ${"x".repeat(Math.min(10, Math.floor(t / 100)))}`, () => "python3");
    const contents = await waitForQuiet(ctx, "S", 5000);
    expect(contents).toBe(`>>> ${"x".repeat(10)}`);
    expect(clock.time).toBeLessThan(1500);
  });

  it("gives up after the maximum wait", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, (t) => `tick ${t}`, () => "top");
    await waitForQuiet(ctx, "S", 2000);
    expect(clock.time).toBe(2000);
  });
});

describe("waitForShellReady", () => {
  it("waits for the first prompt to appear and settle", async () => {
    const clock = virtualClock();
    const ctx = scripted(
      clock,
      (t) => (t < 400 ? "" : "Last login: today\n~ %"),
      (t) => (t < 200 ? "/usr/bin/login -fpl me" : null),
    );
    expect(await waitForShellReady(ctx, { id: "S", tty: TTY }, 5000)).toBe(true);
    expect(clock.time).toBeGreaterThanOrEqual(700);
  });

  it("gives up on a shell that never shows a prompt", async () => {
    const clock = virtualClock();
    const ctx = scripted(clock, () => "", () => null);
    expect(await waitForShellReady(ctx, { id: "S", tty: TTY }, 1000)).toBe(false);
  });
});
