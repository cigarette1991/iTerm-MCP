/**
 * Helpers for turning iTerm2's session text into something useful for a model:
 * splitting into lines, isolating the output produced after a given moment,
 * and trimming it to a reasonable size.
 */

/** Splits terminal text into lines, dropping trailing blanks on each line and blank lines at the end. */
export function toLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const ANCHOR_SIZE = 4;

/**
 * What the session looked like just before we typed something, so the text
 * that appears afterwards can be picked out later.
 */
export interface Baseline {
  lineCount: number;
  /** The last few lines, ending with the line the cursor was on (normally the prompt). */
  anchor: string[];
}

export function captureBaseline(contents: string): Baseline {
  const lines = toLines(contents);
  return { lineCount: lines.length, anchor: lines.slice(-ANCHOR_SIZE) };
}

export interface NewOutput {
  /** New lines, starting with the prompt line the input was typed on. */
  lines: string[];
  /** False when the baseline could not be found (the screen was cleared or scrolled too far) and `lines` is the whole buffer. */
  exact: boolean;
}

/**
 * Returns the lines that appeared since `baseline` was captured.
 *
 * The anchor lines are located in the new text and everything from the anchor's
 * last line onwards is returned. That last line only has to be a prefix match,
 * because what was typed gets appended to the prompt. Searching starts where the
 * anchor used to be and moves up, since old lines can only drop off the top of
 * the scrollback.
 */
export function newOutputSince(baseline: Baseline, contents: string): NewOutput {
  const lines = toLines(contents);
  const { anchor } = baseline;
  const k = anchor.length;
  if (k === 0) return { lines, exact: true };

  const exactLines = anchor.slice(0, k - 1);
  const promptLine = anchor[k - 1];
  const start = Math.min(baseline.lineCount - k, lines.length - k);

  const matchesAt = (p: number, checkPrompt: boolean): boolean => {
    for (let i = 0; i < exactLines.length; i++) {
      if (lines[p + i] !== exactLines[i]) return false;
    }
    return !checkPrompt || lines[p + k - 1].startsWith(promptLine);
  };

  for (let p = start; p >= 0; p--) {
    if (matchesAt(p, true)) return { lines: lines.slice(p + k - 1), exact: true };
  }
  // The prompt line itself may have been redrawn (right-hand prompts, transient
  // prompts), so try again without it when there are enough other lines to go on.
  if (exactLines.length >= 2) {
    for (let p = start; p >= 0; p--) {
      if (matchesAt(p, false)) return { lines: lines.slice(p + k - 1), exact: true };
    }
  }
  return { lines, exact: false };
}

export interface Limited {
  text: string;
  /** Number of lines left out from the start. */
  omittedLines: number;
  /** Number of characters left out from the start (after line trimming). */
  omittedChars: number;
}

/** Keeps the last `maxLines` lines and at most `maxChars` characters (the end matters most for command output). */
export function limitOutput(lines: string[], maxLines: number, maxChars = 50_000): Limited {
  const omittedLines = Math.max(0, lines.length - maxLines);
  let text = lines.slice(omittedLines).join("\n");
  let omittedChars = 0;
  if (text.length > maxChars) {
    omittedChars = text.length - maxChars;
    text = text.slice(omittedChars);
  }
  return { text, omittedLines, omittedChars };
}

/** Formats limited output with a note about anything that was cut. */
export function renderOutput(limited: Limited): string {
  const notes: string[] = [];
  if (limited.omittedLines > 0) notes.push(`${limited.omittedLines} earlier lines omitted`);
  if (limited.omittedChars > 0) notes.push(`${limited.omittedChars} characters omitted`);
  const prefix = notes.length > 0 ? `[... ${notes.join(", ")}]\n` : "";
  return prefix + (limited.text === "" ? "(no output)" : limited.text);
}
