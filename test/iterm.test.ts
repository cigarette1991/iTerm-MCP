import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explainAppleEventError, ITermError, OsascriptITerm, type ExecFileFn } from "../src/iterm.js";
import { JXA_SOURCE } from "../src/jxa.js";
import { FakeApp, runJxa } from "./fakes/jxaModel.js";

/** An osascript stand-in that runs the bridge script against a fake iTerm2. */
function osascriptFor(app: FakeApp, seen: string[][] = []): ExecFileFn {
  return async (file, args) => {
    seen.push([file, ...args]);
    expect(file).toBe("osascript");
    expect(args.slice(0, 4)).toEqual(["-l", "JavaScript", "-e", JXA_SOURCE]);
    return { stdout: `${JSON.stringify(runJxa(app, args[4]))}\n`, stderr: "" };
  };
}

function failingExec(error: Partial<NodeJS.ErrnoException> & { stderr?: string; killed?: boolean; signal?: string }): ExecFileFn {
  return async () => {
    throw Object.assign(new Error(error.message ?? "Command failed"), error);
  };
}

async function errorOf(promise: Promise<unknown>): Promise<ITermError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ITermError);
    return error as ITermError;
  }
  throw new Error("expected a rejection");
}

describe("OsascriptITerm", () => {
  it("drives iTerm2 through the JXA bridge end to end", async () => {
    const app = new FakeApp();
    const window = app.addWindow();
    const session = window.list[0].list[0];
    session.contentsText = "~ % ";
    const seen: string[][] = [];
    const iterm = new OsascriptITerm(osascriptFor(app, seen));

    const list = await iterm.listSessions();
    expect(list.sessions.map((s) => s.id)).toEqual([session.guid]);
    expect(await iterm.getSession()).toMatchObject({ id: session.guid, isCurrent: true });

    await iterm.write(session.guid, "ls", true);
    expect(session.written).toEqual(["ls\r"]);
    expect(await iterm.snapshot(session.guid)).toEqual({ contents: "~ % ", atShellPrompt: false });

    const tab = await iterm.createTab({ name: "build" });
    expect(tab).toMatchObject({ name: "build", tabIndex: 1 });
    const pane = await iterm.splitPane(tab.id, { vertical: false, profile: "Work" });
    expect(pane).toMatchObject({ paneIndex: 1, profile: "Work" });
    await iterm.focus(session.guid);
    await iterm.close(pane.id);
    expect((await iterm.listSessions()).sessions).toHaveLength(2);

    expect(JSON.parse(seen[0][5])).toEqual({ op: "list" });
    expect(JSON.parse(seen[2][5])).toEqual({ op: "write", id: session.guid, text: "ls", newline: true });
  });

  it("passes script errors through with their code", async () => {
    const iterm = new OsascriptITerm(osascriptFor(new FakeApp()));
    const error = await errorOf(iterm.getSession("gone"));
    expect(error.code).toBe("SESSION_NOT_FOUND");
    expect(error.message).toMatch(/list_sessions/);
  });

  it("explains Apple Event errors raised inside the script", async () => {
    const app = new FakeApp();
    app.addWindow();
    const error = await errorOf(new OsascriptITerm(osascriptFor(app)).createTab({ profile: "Missing" }));
    expect(error.code).toBe("APPLE_EVENT_ERROR");
    expect(error.message).toBe("iTerm2 reported an error: No profile named Missing");
  });

  it("explains a missing Automation permission", async () => {
    const exec = failingExec({ stderr: "execution error: Error: Not authorized to send Apple events to iTerm2. (-1743)\n" });
    const error = await errorOf(new OsascriptITerm(exec).listSessions());
    expect(error.code).toBe("NOT_AUTHORIZED");
    expect(error.message).toMatch(/Privacy & Security → Automation/);
  });

  it("explains a missing osascript (not macOS)", async () => {
    const error = await errorOf(new OsascriptITerm(failingExec({ code: "ENOENT" })).listSessions());
    expect(error.code).toBe("NO_OSASCRIPT");
  });

  it("explains a hung iTerm2", async () => {
    const error = await errorOf(new OsascriptITerm(failingExec({ killed: true, signal: "SIGTERM" }), 5000).listSessions());
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toMatch(/within 5s/);
  });

  it("rejects output that is not a bridge reply", async () => {
    const exec: ExecFileFn = async () => ({ stdout: "something odd\n", stderr: "" });
    const error = await errorOf(new OsascriptITerm(exec).listSessions());
    expect(error.code).toBe("BAD_REPLY");
  });
});

describe("explainAppleEventError", () => {
  it.each([
    [-1743, "whatever", "NOT_AUTHORIZED"],
    [null, "Not authorised to send Apple events to iTerm2.", "NOT_AUTHORIZED"],
    [-600, "Application isn't running.", "NOT_RUNNING"],
    [null, "Error: Application can't be found. (-2700)", "NOT_INSTALLED"],
    [-1712, "AppleEvent timed out.", "TIMEOUT"],
    [-1728, "Can't get object.", "APPLE_EVENT_ERROR"],
  ])("%s %j -> %s", (errorNumber, message, code) => {
    expect(explainAppleEventError(errorNumber, message).code).toBe(code);
  });
});

// On a Mac (including CI), run the bridge through the real osascript. Only the
// ping op is used unless iTerm2 is absent, so this never touches a user's windows.
describe.runIf(process.platform === "darwin")("with the real osascript", () => {
  it("runs the bridge script under JavaScript for Automation", async () => {
    const iterm = new OsascriptITerm();
    expect(await iterm.call("ping")).toEqual({ pong: true });
  });

  it.runIf(!existsSync("/Applications/iTerm.app"))("explains that iTerm2 is not installed", async () => {
    const error = await errorOf(new OsascriptITerm().listSessions());
    expect(error.code).toBe("NOT_INSTALLED");
  });
});
