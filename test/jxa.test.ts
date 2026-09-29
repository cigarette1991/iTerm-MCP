import { describe, expect, it } from "vitest";
import { JXA_SOURCE } from "../src/jxa.js";
import { FakeApp, runJxa } from "./fakes/jxaModel.js";

function twoWindows() {
  const app = new FakeApp();
  const first = app.addWindow();
  const splitSource = first.list[0].list[0];
  splitSource.splitVerticallyWithDefaultProfile();
  first.addTab();
  const second = app.addWindow();
  return { app, first, second };
}

describe("JXA bridge script", () => {
  it("is a self-contained classic script with a run handler", () => {
    expect(JXA_SOURCE).toMatch(/^function jxaMain\(argv\)/);
    expect(JXA_SOURCE).toContain("function run(argv) { return jxaMain(argv); }");
    // No module syntax or compiler helpers that JavaScriptCore would not know about.
    expect(JXA_SOURCE).not.toMatch(/\b(import|export|require)\b|__awaiter|__name/);
  });

  it("answers ping without touching iTerm2", () => {
    const reply = runJxa(() => {
      throw new Error("should not be called");
    }, { op: "ping" });
    expect(reply).toEqual({ ok: true, result: { pong: true } });
  });

  it("rejects malformed requests", () => {
    expect(runJxa(new FakeApp(), "{nope").code).toBe("BAD_REQUEST");
    expect(runJxa(new FakeApp(), { op: "explode" })).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  it("lists every session with its position and focus", () => {
    const { app, first, second } = twoWindows();
    const reply = runJxa(app, { op: "list" });
    expect(reply.ok).toBe(true);
    const { sessions, currentSessionId, running } = reply.result;
    expect(running).toBe(true);
    expect(sessions).toHaveLength(4);
    expect(sessions.map((s: { windowId: number; tabIndex: number; paneIndex: number }) => [s.windowId, s.tabIndex, s.paneIndex])).toEqual([
      [first.windowId, 0, 0],
      [first.windowId, 0, 1],
      [first.windowId, 1, 0],
      [second.windowId, 0, 0],
    ]);
    const secondSession = second.list[0].list[0];
    expect(currentSessionId).toBe(secondSession.guid);
    expect(sessions[3]).toMatchObject({
      id: secondSession.guid,
      tty: secondSession.ttyPath,
      cwd: "/Users/me",
      profile: "Default",
      columns: 80,
      rows: 24,
      isCurrent: true,
      isActiveInTab: true,
    });
    expect(sessions[1]).toMatchObject({ isCurrent: false, isActiveInTab: false });
  });

  it("reports when iTerm2 is not running instead of launching it", () => {
    const app = new FakeApp();
    app.isRunning = false;
    expect(runJxa(app, { op: "list" }).result).toEqual({ running: false, currentSessionId: null, sessions: [] });
    expect(runJxa(app, { op: "get" })).toMatchObject({ ok: false, code: "NOT_RUNNING" });
    expect(app.activations).toBe(0);
  });

  it("gets the focused session by default and any session by id", () => {
    const { app, first } = twoWindows();
    const pane = first.list[0].list[1];
    expect(runJxa(app, { op: "get" }).result.isCurrent).toBe(true);
    expect(runJxa(app, { op: "get", id: pane.guid }).result).toMatchObject({ id: pane.guid, paneIndex: 1 });
    expect(runJxa(app, { op: "get", id: "missing" })).toMatchObject({ ok: false, code: "SESSION_NOT_FOUND" });
  });

  it("fails clearly when there is no window to default to", () => {
    const app = new FakeApp();
    expect(runJxa(app, { op: "get" })).toMatchObject({ ok: false, code: "NO_SESSION" });
  });

  it("reads contents and the shell-integration prompt flag", () => {
    const app = new FakeApp();
    const session = app.addWindow().list[0].list[0];
    session.contentsText = "~ % ls\nREADME.md\n~ % ";
    session.shellPrompt = true;
    expect(runJxa(app, { op: "snapshot", id: session.guid }).result).toEqual({
      contents: "~ % ls\nREADME.md\n~ % ",
      atShellPrompt: true,
    });
  });

  it("writes text with or without a newline", () => {
    const app = new FakeApp();
    const session = app.addWindow().list[0].list[0];
    runJxa(app, { op: "write", id: session.guid, text: "ls -la", newline: true });
    runJxa(app, { op: "write", id: session.guid, text: "\u0003", newline: false });
    expect(session.written).toEqual(["ls -la\r", "\u0003"]);
  });

  it("creates tabs in the focused window, a chosen window, or a new window", () => {
    const { app, first, second } = twoWindows();
    const inFront = runJxa(app, { op: "createTab", name: "build" });
    expect(inFront.ok).toBe(true);
    expect(inFront.result).toMatchObject({ windowId: second.windowId, tabIndex: 1, name: "build" });

    const inFirst = runJxa(app, { op: "createTab", windowId: first.windowId, profile: "Work" });
    expect(inFirst.result).toMatchObject({ windowId: first.windowId, tabIndex: 2, profile: "Work" });

    expect(runJxa(app, { op: "createTab", windowId: 4242 })).toMatchObject({ ok: false, code: "WINDOW_NOT_FOUND" });

    const empty = new FakeApp();
    const created = runJxa(empty, { op: "createTab" });
    expect(created.ok).toBe(true);
    expect(empty.list).toHaveLength(1);
  });

  it("surfaces AppleScript errors such as unknown profiles", () => {
    const app = new FakeApp();
    app.addWindow();
    expect(runJxa(app, { op: "createTab", profile: "Nope" })).toMatchObject({
      ok: false,
      code: "APPLE_EVENT_ERROR",
      error: "No profile named Nope",
      errorNumber: -2700,
    });
  });

  it("creates windows, launching iTerm2 and reusing its startup window when needed", () => {
    const app = new FakeApp();
    const created = runJxa(app, { op: "createWindow", profile: "Work", name: "server" });
    expect(created.result).toMatchObject({ profile: "Work", name: "server", isCurrent: true });

    const stopped = new FakeApp();
    stopped.isRunning = false;
    const launched = runJxa(stopped, { op: "createWindow" });
    expect(launched.ok).toBe(true);
    expect(stopped.activations).toBe(1);
    expect(stopped.list).toHaveLength(1);

    const noStartupWindow = new FakeApp();
    noStartupWindow.isRunning = false;
    noStartupWindow.opensWindowOnLaunch = false;
    expect(runJxa(noStartupWindow, { op: "createTab" }).ok).toBe(true);
    expect(noStartupWindow.list).toHaveLength(1);
  });

  it("splits panes in both directions", () => {
    const app = new FakeApp();
    const tab = app.addWindow().list[0];
    const source = tab.list[0];
    const right = runJxa(app, { op: "split", id: source.guid, vertical: true, name: "tests" });
    expect(right.result).toMatchObject({ paneIndex: 1, name: "tests" });
    const below = runJxa(app, { op: "split", id: source.guid, vertical: false, profile: "Work" });
    expect(below.result).toMatchObject({ paneIndex: 1, profile: "Work" });
    expect(source.calls).toEqual(["split vertically", "split horizontally"]);
  });

  it("focuses and closes sessions", () => {
    const { app, first } = twoWindows();
    const pane = first.list[0].list[1];
    expect(runJxa(app, { op: "focus", id: pane.guid }).ok).toBe(true);
    expect(app.activations).toBe(1);
    expect(app.front).toBe(first);
    expect(first.current).toBe(first.list[0]);
    expect(pane.calls).toContain("select");

    expect(runJxa(app, { op: "close", id: pane.guid }).ok).toBe(true);
    expect(pane.closed).toBe(true);
    expect(runJxa(app, { op: "get", id: pane.guid }).code).toBe("SESSION_NOT_FOUND");
  });
});
