import { describe, expect, it } from "vitest";
import { keySequence, keysToText } from "../src/keys.js";

describe("keySequence", () => {
  it.each([
    ["ctrl+c", "\x03"],
    ["Ctrl-C", "\x03"],
    ["control+d", "\x04"],
    ["C-z", "\x1a"],
    ["^L", "\x0c"],
    ["ctrl+[", "\x1b"],
    ["ctrl+\\", "\x1c"],
    ["ctrl+space", "\x00"],
    ["enter", "\r"],
    ["Return", "\r"],
    ["tab", "\t"],
    ["shift+tab", "\x1b[Z"],
    ["esc", "\x1b"],
    ["escape", "\x1b"],
    ["backspace", "\x7f"],
    ["delete", "\x1b[3~"],
    ["up", "\x1b[A"],
    ["ArrowDown", "\x1b[B"],
    ["arrow_right", "\x1b[C"],
    ["left", "\x1b[D"],
    ["page_up", "\x1b[5~"],
    ["PageDown", "\x1b[6~"],
    ["home", "\x1b[H"],
    ["end", "\x1b[F"],
    ["f1", "\x1bOP"],
    ["F12", "\x1b[24~"],
    ["alt+b", "\x1bb"],
    ["option+left", "\x1b\x1b[D"],
    ["M-x", "\x1bx"],
    ["shift+a", "A"],
    ["space", " "],
    [" ", " "],
    ["q", "q"],
    [":", ":"],
  ])("%j -> %j", (name, expected) => {
    expect(keySequence(name)).toBe(expected);
  });

  it("rejects unknown keys with a list of valid ones", () => {
    expect(() => keySequence("hyper+x")).toThrow(/Unknown key "hyper\+x".*ctrl\+<letter>/);
    expect(() => keySequence("ctrl+1")).toThrow(/Unsupported control key/);
    expect(() => keySequence("shift+up")).toThrow(/shift\+tab/);
  });
});

describe("keysToText", () => {
  it("concatenates keys in order", () => {
    expect(keysToText(["escape", ":", "w", "q", "enter"])).toBe("\x1b:wq\r");
  });
});
