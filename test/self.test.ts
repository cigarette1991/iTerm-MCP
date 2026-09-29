import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../src/processes.js";
import { detectSelf, isSelf, sessionIdFromEnv } from "../src/self.js";

const GUID = "6E1A3F2B-6A2C-4B67-9F3E-0123456789AB";

describe("sessionIdFromEnv", () => {
  it("reads iTerm2's session id", () => {
    expect(sessionIdFromEnv({ ITERM_SESSION_ID: `w0t1p2:${GUID}` })).toBe(GUID);
    expect(sessionIdFromEnv({ TERM_SESSION_ID: `w1t0p0:${GUID}` })).toBe(GUID);
  });

  it("ignores Terminal.app's session id and missing values", () => {
    expect(sessionIdFromEnv({ TERM_SESSION_ID: GUID })).toBeNull();
    expect(sessionIdFromEnv({})).toBeNull();
  });
});

describe("detectSelf", () => {
  const processes: ProcessInfo[] = [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 100, stat: "S+", tty: "ttys007", args: "claude" },
    { pid: 200, ppid: 100, pgid: 200, tpgid: 100, stat: "S", tty: "??", args: "node dist/index.js" },
  ];

  it("combines the environment with the inherited terminal", async () => {
    expect(await detectSelf({ ITERM_SESSION_ID: `w0t0p0:${GUID}` }, async () => processes, 200)).toEqual({
      sessionId: GUID,
      tty: "s007",
    });
  });

  it("copes without ps", async () => {
    const failing = async () => {
      throw new Error("no ps");
    };
    expect(await detectSelf({}, failing, 200)).toEqual({ sessionId: null, tty: null });
  });
});

describe("isSelf", () => {
  it("matches by session id (case-insensitively) or by tty", () => {
    const session = { id: GUID, tty: "/dev/ttys007" };
    expect(isSelf(session, { sessionId: GUID.toLowerCase(), tty: null })).toBe(true);
    expect(isSelf(session, { sessionId: null, tty: "s007" })).toBe(true);
    expect(isSelf(session, { sessionId: "OTHER", tty: "s008" })).toBe(false);
    expect(isSelf(session, { sessionId: null, tty: null })).toBe(false);
  });
});
