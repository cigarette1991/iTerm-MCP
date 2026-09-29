/**
 * The part of the server that actually talks to iTerm2.
 *
 * `jxaMain` runs inside `osascript -l JavaScript` (JavaScript for Automation),
 * not inside Node. It is shipped as source text via Function.prototype.toString,
 * so it must stay completely self-contained: no imports, no references to
 * anything outside its own body, and only plain ES2017 syntax that macOS's
 * JavaScriptCore accepts.
 *
 * Protocol: argv[0] is a JSON request `{ op, ...params }`; the return value is a
 * JSON reply, either `{ ok: true, result }` or
 * `{ ok: false, code, error, errorNumber? }`.
 *
 * Property and command names follow iTerm2's scripting dictionary (iTerm2.sdef),
 * camel-cased the way JXA exposes them, e.g. "split vertically with default
 * profile" becomes `session.splitVerticallyWithDefaultProfile()`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const Application: any;
declare function delay(seconds: number): void;

export function jxaMain(argv: string[]): string {
  const ITERM_BUNDLE_ID = "com.googlecode.iterm2";

  function reply(result: any): string {
    return JSON.stringify({ ok: true, result: result === undefined ? null : result });
  }

  function problem(code: string, message: string): any {
    return { isProblem: true, code: code, message: message };
  }

  function attempt(fn: () => any, fallback: any): any {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  let request: any;
  try {
    request = JSON.parse(argv[0]);
  } catch (e) {
    return JSON.stringify({ ok: false, code: "BAD_REQUEST", error: "The request must be a JSON object." });
  }

  // Lets the server (and CI) check that osascript can run this script at all,
  // without touching iTerm2.
  if (request.op === "ping") {
    return reply({ pong: true });
  }

  try {
    const app = Application(ITERM_BUNDLE_ID);

    const currentIds = function (): any {
      const win = attempt(function () { return app.currentWindow(); }, null);
      if (!win) return { windowId: null, sessionId: null };
      return {
        windowId: attempt(function () { return win.id(); }, null),
        sessionId: attempt(function () { return win.currentSession().id(); }, null),
      };
    };

    // Calls visit(session, where) for every session in every tab of every
    // window, stopping early when visit returns true.
    const forEachSession = function (visit: (session: any, where: any) => boolean): void {
      const windows = app.windows();
      for (let w = 0; w < windows.length; w++) {
        const win = windows[w];
        const windowId = attempt(function () { return win.id(); }, null);
        const tabs = attempt(function () { return win.tabs(); }, []);
        for (let t = 0; t < tabs.length; t++) {
          const tab = tabs[t];
          const activeId = attempt(function () { return tab.currentSession().id(); }, null);
          const sessions = attempt(function () { return tab.sessions(); }, []);
          for (let p = 0; p < sessions.length; p++) {
            const where = {
              window: win,
              tab: tab,
              windowId: windowId,
              windowIndex: w,
              tabIndex: t,
              paneIndex: p,
              activeId: activeId,
            };
            if (visit(sessions[p], where)) return;
          }
        }
      }
    };

    const find = function (id: string): any {
      let found: any = null;
      forEachSession(function (session, where) {
        if (attempt(function () { return session.id(); }, null) === id) {
          found = { session: session, where: where };
          return true;
        }
        return false;
      });
      if (!found) {
        throw problem("SESSION_NOT_FOUND", "No iTerm2 session has id " + id + ". Call list_sessions to see the open sessions.");
      }
      return found;
    };

    const describe = function (session: any, where: any, current: any): any {
      const id = session.id();
      return {
        id: id,
        name: attempt(function () { return session.name(); }, ""),
        tty: attempt(function () { return session.tty(); }, ""),
        profile: attempt(function () { return session.profileName(); }, null),
        columns: attempt(function () { return session.columns(); }, null),
        rows: attempt(function () { return session.rows(); }, null),
        cwd: attempt(function () { return session.variable({ named: "path" }); }, null),
        windowId: where.windowId,
        windowIndex: where.windowIndex,
        tabIndex: where.tabIndex,
        paneIndex: where.paneIndex,
        isActiveInTab: id === where.activeId,
        isCurrent: id === current.sessionId,
      };
    };

    const describeById = function (id: string): any {
      const found = find(id);
      return describe(found.session, found.where, currentIds());
    };

    const requireRunning = function (): void {
      if (!app.running()) {
        throw problem("NOT_RUNNING", "iTerm2 is not running. Use create_window to start it.");
      }
    };

    // Starts iTerm2 if needed. Returns the session of the window iTerm2 opens
    // at launch, if it opens one, so callers can use it instead of creating
    // yet another window.
    const launchIfNeeded = function (): any {
      if (app.running()) return null;
      app.activate();
      for (let i = 0; i < 100; i++) {
        if (attempt(function () { return app.windows().length; }, 0) > 0) break;
        delay(0.1);
      }
      const win = attempt(function () { return app.currentWindow(); }, null);
      return win ? win.currentSession() : null;
    };

    const nameSession = function (session: any): void {
      if (typeof request.name === "string" && request.name.length > 0) {
        session.name = request.name;
      }
    };

    const createWindow = function (): any {
      const win = request.profile
        ? app.createWindowWithProfile(request.profile)
        : app.createWindowWithDefaultProfile();
      if (!win) throw problem("CREATE_FAILED", "iTerm2 did not create a window.");
      return win.currentSession();
    };

    switch (request.op) {
      case "list": {
        if (!app.running()) return reply({ running: false, currentSessionId: null, sessions: [] });
        const current = currentIds();
        const sessions: any[] = [];
        forEachSession(function (session, where) {
          sessions.push(describe(session, where, current));
          return false;
        });
        return reply({ running: true, currentSessionId: current.sessionId, sessions: sessions });
      }

      case "get": {
        requireRunning();
        let id = request.id;
        if (!id) {
          id = currentIds().sessionId;
          if (!id) throw problem("NO_SESSION", "iTerm2 has no open windows. Use create_window to open one.");
        }
        return reply(describeById(id));
      }

      case "snapshot": {
        requireRunning();
        const session = find(request.id).session;
        return reply({
          contents: session.contents(),
          atShellPrompt: attempt(function () { return session.isAtShellPrompt(); }, null),
        });
      }

      case "write": {
        requireRunning();
        find(request.id).session.write({ text: request.text, newline: request.newline === true });
        return reply(null);
      }

      case "createWindow": {
        const launched = launchIfNeeded();
        const session = launched || createWindow();
        nameSession(session);
        return reply(describeById(session.id()));
      }

      case "createTab": {
        const launched = launchIfNeeded();
        let session = launched;
        if (!session) {
          let win: any = null;
          if (request.windowId !== undefined && request.windowId !== null) {
            win = app.windows.byId(request.windowId);
            if (attempt(function () { return win.id(); }, null) === null) {
              throw problem("WINDOW_NOT_FOUND", "No iTerm2 window has id " + request.windowId + ".");
            }
          } else {
            win = attempt(function () { return app.currentWindow(); }, null);
          }
          if (win) {
            const tab = request.profile
              ? win.createTab({ withProfile: request.profile })
              : win.createTabWithDefaultProfile();
            if (!tab) throw problem("CREATE_FAILED", "iTerm2 did not create a tab.");
            session = tab.currentSession();
          } else {
            session = createWindow();
          }
        }
        nameSession(session);
        return reply(describeById(session.id()));
      }

      case "split": {
        requireRunning();
        const source = find(request.id).session;
        let created: any;
        if (request.profile) {
          created = request.vertical
            ? source.splitVertically({ withProfile: request.profile })
            : source.splitHorizontally({ withProfile: request.profile });
        } else {
          created = request.vertical
            ? source.splitVerticallyWithDefaultProfile()
            : source.splitHorizontallyWithDefaultProfile();
        }
        if (!created) {
          throw problem("CREATE_FAILED", "iTerm2 did not create a split pane (splitting tmux-integrated sessions is not supported).");
        }
        nameSession(created);
        return reply(describeById(created.id()));
      }

      case "focus": {
        requireRunning();
        const found = find(request.id);
        app.activate();
        found.where.window.select();
        found.where.tab.select();
        found.session.select();
        return reply(null);
      }

      case "close": {
        requireRunning();
        find(request.id).session.close();
        return reply(null);
      }

      default:
        return JSON.stringify({ ok: false, code: "BAD_REQUEST", error: "Unknown op: " + request.op });
    }
  } catch (e: any) {
    if (e && e.isProblem) {
      return JSON.stringify({ ok: false, code: e.code, error: e.message });
    }
    const message = e && e.message ? String(e.message) : String(e);
    const errorNumber = e && typeof e.errorNumber === "number" ? e.errorNumber : null;
    return JSON.stringify({ ok: false, code: "APPLE_EVENT_ERROR", error: message, errorNumber: errorNumber });
  }
}

/** Complete JXA program passed to `osascript -l JavaScript -e`. */
export const JXA_SOURCE = `${jxaMain.toString()}\nfunction run(argv) { return jxaMain(argv); }\n`;
