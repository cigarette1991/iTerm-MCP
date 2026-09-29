import type { ITermBackend } from "./iterm.js";
import { newOutputSince, type Baseline } from "./output.js";
import { jobStateForTty, type JobState, type ProcessLister } from "./processes.js";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export interface Timing {
  /** How often to poll iTerm2 and ps. */
  pollMs: number;
  /** How long output must stay unchanged before it counts as settled. */
  settleMs: number;
  /** Pause after typing before the first check, so the shell can start the command. */
  initialDelayMs: number;
  /** Quiet period that ends a command even if shell integration never reports the prompt. */
  promptGraceMs: number;
}

export const DEFAULT_TIMING: Timing = { pollMs: 250, settleMs: 500, initialDelayMs: 200, promptGraceMs: 2000 };

export interface WaitContext {
  iterm: ITermBackend;
  processes: ProcessLister;
  clock: Clock;
  timing: Timing;
  signal?: AbortSignal;
  /** Called about once a second while waiting, with elapsed and total milliseconds. */
  onProgress?: (elapsedMs: number, totalMs: number) => void;
}

export type WaitOutcome = "finished" | "matched" | "timeout" | "cancelled";

export interface WaitResult {
  outcome: WaitOutcome;
  contents: string;
  /** Latest job state; null if ps could not be run. */
  job: JobState | null;
  /** Text that matched the pattern, for outcome "matched". */
  match?: string;
}

async function jobState(ctx: WaitContext, tty: string): Promise<JobState | null> {
  try {
    return jobStateForTty(await ctx.processes(), tty);
  } catch {
    return null;
  }
}

function progressTicker(ctx: WaitContext, start: number, totalMs: number): () => void {
  let lastReport = start;
  return () => {
    const now = ctx.clock.now();
    if (ctx.onProgress && now - lastReport >= 1000) {
      lastReport = now;
      ctx.onProgress(now - start, totalMs);
    }
  };
}

export interface CommandWaitOptions {
  sessionId: string;
  tty: string;
  timeoutMs: number;
  /** Output to search for `pattern` is measured from here. */
  baseline: Baseline;
  /** Stop as soon as the new output matches. */
  pattern?: RegExp;
  /**
   * Also require iTerm2's shell-integration "at prompt" flag. Only set this
   * when the flag was seen to be true before the command was sent, which
   * shows shell integration is installed.
   */
  useShellIntegration?: boolean;
}

/**
 * Waits for the command running in a session to finish: nothing but the shell
 * in the foreground and the output unchanged for `settleMs`. Returns early when
 * `pattern` matches the new output, and gives up after `timeoutMs`.
 */
export async function waitForCommand(ctx: WaitContext, options: CommandWaitOptions): Promise<WaitResult> {
  const { clock, timing } = ctx;
  const start = clock.now();
  const tick = progressTicker(ctx, start, options.timeoutMs);
  let contents: string | null = null;
  let job: JobState | null = null;
  let stableContents: string | null = null;
  let stableSince = start;

  const giveUp = async (outcome: WaitOutcome): Promise<WaitResult> => {
    if (contents === null) contents = (await ctx.iterm.snapshot(options.sessionId)).contents;
    return { outcome, contents, job };
  };

  await clock.sleep(Math.min(timing.initialDelayMs, options.timeoutMs), ctx.signal);
  for (;;) {
    if (ctx.signal?.aborted) return giveUp("cancelled");

    job = await jobState(ctx, options.tty);
    const busy = job?.busy ?? false;
    // While a command is busy there is nothing to learn from the screen unless
    // we are looking for a pattern, so skip the (potentially large) read.
    contents = null;

    if (options.pattern || !busy) {
      const snapshot = await ctx.iterm.snapshot(options.sessionId);
      contents = snapshot.contents;

      if (options.pattern) {
        const text = newOutputSince(options.baseline, contents).lines.join("\n");
        options.pattern.lastIndex = 0;
        const match = options.pattern.exec(text);
        if (match) return { outcome: "matched", contents, job, match: match[0] };
      }

      if (!busy) {
        const now = clock.now();
        if (contents !== stableContents) {
          stableContents = contents;
          stableSince = now;
        } else {
          const quietMs = now - stableSince;
          const atPrompt = !options.useShellIntegration || snapshot.atShellPrompt === true;
          // Without the prompt flag (e.g. the command started a shell that lacks
          // shell integration), fall back to a longer quiet period.
          if ((atPrompt && quietMs >= timing.settleMs) || quietMs >= timing.promptGraceMs) {
            return { outcome: "finished", contents, job };
          }
        }
      } else {
        stableContents = null;
      }
    } else {
      stableContents = null;
    }

    tick();
    if (clock.now() - start >= options.timeoutMs) return giveUp("timeout");
    await clock.sleep(timing.pollMs, ctx.signal);
  }
}

/**
 * Waits until the session's text stops changing for `settleMs`, or until
 * `maxMs` has passed. Used after sending input to interactive programs, where
 * there is no "command finished" signal to wait for.
 */
export async function waitForQuiet(ctx: WaitContext, sessionId: string, maxMs: number): Promise<string> {
  const { clock, timing } = ctx;
  const start = clock.now();
  const tick = progressTicker(ctx, start, maxMs);
  await clock.sleep(Math.min(timing.initialDelayMs, maxMs), ctx.signal);
  let previous = (await ctx.iterm.snapshot(sessionId)).contents;
  let stableSince = clock.now();
  while (!ctx.signal?.aborted) {
    const now = clock.now();
    if (now - start >= maxMs || now - stableSince >= timing.settleMs) break;
    tick();
    await clock.sleep(timing.pollMs, ctx.signal);
    const contents = (await ctx.iterm.snapshot(sessionId)).contents;
    if (contents !== previous) {
      previous = contents;
      stableSince = clock.now();
    }
  }
  return previous;
}

/**
 * Waits for a freshly created session to show its first prompt: something on
 * screen, only the shell in the foreground, and the text settled.
 */
export async function waitForShellReady(
  ctx: WaitContext,
  session: { id: string; tty: string },
  timeoutMs: number,
): Promise<boolean> {
  const { clock, timing } = ctx;
  const start = clock.now();
  let stableContents: string | null = null;
  let stableSince = start;
  while (!ctx.signal?.aborted) {
    const job = await jobState(ctx, session.tty);
    // An unknown job state (ps failed, or has not seen the tty yet) falls back
    // to judging by the screen alone.
    if (job === null || !job.busy) {
      const contents = (await ctx.iterm.snapshot(session.id)).contents;
      const now = clock.now();
      if (contents.trim() === "" || contents !== stableContents) {
        stableContents = contents;
        stableSince = now;
      } else if (now - stableSince >= timing.settleMs) {
        return true;
      }
    } else {
      stableContents = null;
    }
    if (clock.now() - start >= timeoutMs) return false;
    await clock.sleep(timing.pollMs, ctx.signal);
  }
  return false;
}
