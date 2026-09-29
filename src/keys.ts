/**
 * Translates key names such as "ctrl+c", "enter" or "up" into the bytes a
 * terminal would send for them.
 */

const ESC = "\x1b";

const NAMED_KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  shifttab: `${ESC}[Z`,
  backtab: `${ESC}[Z`,
  escape: ESC,
  esc: ESC,
  space: " ",
  backspace: "\x7f",
  delete: `${ESC}[3~`,
  del: `${ESC}[3~`,
  insert: `${ESC}[2~`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  f1: `${ESC}OP`,
  f2: `${ESC}OQ`,
  f3: `${ESC}OR`,
  f4: `${ESC}OS`,
  f5: `${ESC}[15~`,
  f6: `${ESC}[17~`,
  f7: `${ESC}[18~`,
  f8: `${ESC}[19~`,
  f9: `${ESC}[20~`,
  f10: `${ESC}[21~`,
  f11: `${ESC}[23~`,
  f12: `${ESC}[24~`,
};

const CONTROL_SYMBOLS: Record<string, number> = {
  "@": 0,
  space: 0,
  "[": 27,
  "\\": 28,
  "]": 29,
  "^": 30,
  _: 31,
  "?": 127,
};

export const KEY_HELP =
  "Keys: enter, tab, shift+tab, escape, space, backspace, delete, insert, up, down, left, right, " +
  "home, end, page_up, page_down, f1-f12; ctrl+<letter> (e.g. ctrl+c, ctrl+d, ctrl+z, ctrl+r, ctrl+l) and " +
  "ctrl+[ \\ ] ^ _ @; alt+<key> (sends Escape first, e.g. alt+b, alt+f); or any single character, sent as-is.";

export class KeyError extends Error {}

function lookupNamed(name: string): string | undefined {
  const compact = name.toLowerCase().replace(/[\s_-]/g, "").replace(/^arrow|arrow$/g, "");
  return NAMED_KEYS[compact];
}

/** Returns the byte sequence for one key description. */
export function keySequence(input: string): string {
  const key = input.trim() === "" ? input : input.trim();
  if (key.length === 1) return key;

  // Caret notation: ^C
  if (/^\^.$/.test(key)) return control(key.slice(1), input);

  const modifier = /^(ctrl|control|ctl|c|alt|option|opt|meta|m|shift|s)[+-](.+)$/i.exec(key);
  if (modifier) {
    const mod = modifier[1].toLowerCase();
    const rest = modifier[2];
    if (mod === "shift" || mod === "s") {
      if (rest.toLowerCase() === "tab") return NAMED_KEYS.shifttab;
      if (rest.length === 1) return rest.toUpperCase();
      throw new KeyError(`Unsupported key "${input}". Only shift+tab and shift+<character> are supported.`);
    }
    if (mod === "alt" || mod === "option" || mod === "opt" || mod === "meta" || mod === "m") {
      return ESC + keySequence(rest);
    }
    return control(rest, input);
  }

  const named = lookupNamed(key);
  if (named !== undefined) return named;
  throw new KeyError(`Unknown key "${input}". ${KEY_HELP}`);
}

function control(target: string, original: string): string {
  if (/^[a-z]$/i.test(target)) {
    return String.fromCharCode(target.toLowerCase().charCodeAt(0) - 96);
  }
  const code = CONTROL_SYMBOLS[target.toLowerCase()];
  if (code !== undefined) return String.fromCharCode(code);
  throw new KeyError(`Unsupported control key "${original}". Use ctrl+<letter> or ctrl+ one of [ \\ ] ^ _ @.`);
}

/** Converts a list of key names into one string to send. */
export function keysToText(keys: string[]): string {
  return keys.map(keySequence).join("");
}
