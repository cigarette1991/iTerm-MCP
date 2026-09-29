import { describe, expect, it } from "vitest";
import { captureBaseline, limitOutput, newOutputSince, renderOutput, toLines } from "../src/output.js";

const screen = (...lines: string[]) => lines.join("\n");

describe("toLines", () => {
  it("normalises line endings and trims trailing blanks", () => {
    expect(toLines("a  \r\nb\rc\n\n   \n")).toEqual(["a", "b", "c"]);
    expect(toLines("")).toEqual([]);
  });

  it("keeps blank lines in the middle", () => {
    expect(toLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("newOutputSince", () => {
  const before = screen("Last login: today", "~ % echo one", "one", "~ % ", "", "", "");

  it("returns the typed command line and everything after it", () => {
    const after = screen("Last login: today", "~ % echo one", "one", "~ % ls", "a.txt", "b.txt", "~ % ", "");
    expect(newOutputSince(captureBaseline(before), after)).toEqual({
      lines: ["~ % ls", "a.txt", "b.txt", "~ %"],
      exact: true,
    });
  });

  it("copes with lines dropping off the top of a full scrollback", () => {
    const history = screen("old 1", "old 2", "old 3", "~ % echo one", "one", "~ %");
    const after = screen("old 3", "~ % echo one", "one", "~ % ls", "a.txt", "b.txt", "~ %");
    expect(newOutputSince(captureBaseline(history), after)).toEqual({
      lines: ["~ % ls", "a.txt", "b.txt", "~ %"],
      exact: true,
    });
  });

  it("gives up when the output overflowed the whole scrollback", () => {
    const after = screen("line 998", "line 999", "~ %");
    expect(newOutputSince(captureBaseline(before), after).exact).toBe(false);
  });

  it("prefers the most recent copy of a repeated prompt", () => {
    const history = screen("~ % ls", "a.txt", "~ % ls", "a.txt", "~ %");
    const after = screen("~ % ls", "a.txt", "~ % ls", "a.txt", "~ % pwd", "/tmp", "~ %");
    expect(newOutputSince(captureBaseline(history), after).lines).toEqual(["~ % pwd", "/tmp", "~ %"]);
  });

  it("tolerates a redrawn prompt line (right prompt, transient prompt)", () => {
    const withRightPrompt = screen("x", "y", "z", "~ %                     12:00");
    const after = screen("x", "y", "z", "❯ make", "done", "~ %                     12:01");
    expect(newOutputSince(captureBaseline(withRightPrompt), after)).toEqual({
      lines: ["❯ make", "done", "~ %                     12:01"],
      exact: true,
    });
  });

  it("treats everything as new when the session was empty", () => {
    expect(newOutputSince(captureBaseline(""), "hello\n~ %")).toEqual({ lines: ["hello", "~ %"], exact: true });
  });

  it("falls back to the whole buffer when the anchor is gone", () => {
    const after = screen("totally", "different");
    expect(newOutputSince(captureBaseline(before), after)).toEqual({ lines: ["totally", "different"], exact: false });
  });
});

describe("limitOutput / renderOutput", () => {
  it("keeps the last lines and says how many were dropped", () => {
    const limited = limitOutput(["1", "2", "3", "4"], 2);
    expect(limited).toEqual({ text: "3\n4", omittedLines: 2, omittedChars: 0 });
    expect(renderOutput(limited)).toBe("[... 2 earlier lines omitted]\n3\n4");
  });

  it("caps very long output by characters", () => {
    const limited = limitOutput(["x".repeat(100)], 10, 30);
    expect(limited.text).toHaveLength(30);
    expect(renderOutput(limited)).toMatch(/^\[\.\.\. 70 characters omitted\]/);
  });

  it("says when there is no output", () => {
    expect(renderOutput(limitOutput([], 10))).toBe("(no output)");
  });
});
