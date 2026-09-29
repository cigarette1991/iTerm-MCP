import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeTty } from "../src/processes.js";
import { createServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import type { SelfIdentity } from "../src/self.js";
import { FakeTerminal, PROMPT, type FakeShell } from "./fakes/terminal.js";

const TIMING = { pollMs: 5, settleMs: 25, initialDelayMs: 5 };

let terminal: FakeTerminal;
let client: Client;
let self: SelfIdentity;

async function connect(): Promise<void> {
  const server = createServer({
    iterm: terminal,
    processes: terminal.processes,
    self: async () => self,
    timing: TIMING,
    readyTimeoutMs: 500,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return { text: first.type === "text" ? first.text : "", isError: result.isError === true };
}

let work: FakeShell;
let own: FakeShell;

beforeEach(async () => {
  terminal = new FakeTerminal();
  own = terminal.addShell({ name: "claude" });
  work = terminal.addShell({ name: "work" });
  self = { sessionId: own.info.id, tty: null };
  terminal.focusedId = work.info.id;
  await connect();
});

afterEach(async () => {
  await client.close();
});

describe("server metadata", () => {
  it("offers the iTerm2 tools and usage instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_session",
      "create_tab",
      "create_window",
      "focus_session",
      "list_sessions",
      "read_output",
      "run_command",
      "send_keys",
      "send_text",
      "split_pane",
      "wait_for_output",
    ]);
    const run = tools.find((t) => t.name === "run_command")!;
    expect(run.inputSchema.required).toEqual(["command"]);
    expect(run.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "read_output")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });
});

describe("list_sessions", () => {
  it("describes every session and marks the assistant's own terminal", async () => {
    terminal.write(work.info.id, "server", true);
    const { text, isError } = await call("list_sessions");
    expect(isError).toBe(false);
    const { sessions } = JSON.parse(text);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ session_id: own.info.id, name: "claude", is_self: true, focused: false, status: "idle at the shell prompt" });
    expect(sessions[1]).toMatchObject({
      session_id: work.info.id,
      is_self: false,
      focused: true,
      size: "120x40",
      cwd: "/Users/me/project",
      status: "running: node server.js",
    });
  });

  it("recognises its own terminal by tty as well", async () => {
    self = { sessionId: null, tty: normalizeTty(work.info.tty) };
    await connect();
    const { sessions } = JSON.parse((await call("list_sessions")).text);
    expect(sessions.map((s: { is_self: boolean }) => s.is_self)).toEqual([false, true]);
  });

  it("says when iTerm2 is not running", async () => {
    terminal.running = false;
    expect((await call("list_sessions")).text).toMatch(/not running/);
  });
});

describe("run_command", () => {
  it("returns just the new output of a command", async () => {
    const { text, isError } = await call("run_command", { command: "echo hello", session_id: work.info.id });
    expect(isError).toBe(false);
    expect(text).toContain("Finished.");
    expect(text).toContain(`"work" (session_id ${work.info.id}`);
    expect(text.split("\n\n")[1]).toBe(`${PROMPT} echo hello\nhello\n${PROMPT}`);
    expect(text).not.toContain("Last login");
  });

  it("targets the focused session by default", async () => {
    await call("run_command", { command: "echo hi" });
    expect(terminal.writes).toEqual([{ id: work.info.id, text: "echo hi", newline: true }]);
  });

  it("waits for slow commands to finish", async () => {
    const { text } = await call("run_command", { command: "slow 150" });
    expect(text).toMatch(/^Finished\./);
    expect(text).toContain("slow done");
  });

  it("returns early with the output so far when the timeout passes", async () => {
    const { text, isError } = await call("run_command", { command: "slow 5000", timeout_seconds: 1 });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Still running after 1\.0s: slow 5000\. Use wait_for_output/);
    expect(text).toContain(`${PROMPT} slow 5000`);
  });

  it("returns as soon as wait_for matches", async () => {
    const { text } = await call("run_command", { command: "server", wait_for: "listening on \\d+" });
    expect(text).toMatch(/^Output matched \/listening on \\d\+\/: "listening on 3000"\. Still running: node server\.js\./);
  });

  it("refuses to type into the assistant's own terminal", async () => {
    terminal.focusedId = own.info.id;
    const byDefault = await call("run_command", { command: "ls" });
    expect(byDefault.isError).toBe(true);
    expect(byDefault.text).toMatch(/^The focused iTerm2 session is the terminal this assistant is running in/);
    const explicit = await call("run_command", { command: "ls", session_id: own.info.id });
    expect(explicit.text).toMatch(/split_pane or create_tab/);
    expect(terminal.writes).toEqual([]);
  });

  it("refuses to type a command into a busy program", async () => {
    await call("run_command", { command: "server", wait_for: "listening" });
    const { text, isError } = await call("run_command", { command: "ls" });
    expect(isError).toBe(true);
    expect(text).toMatch(/busy running node server\.js/);
    expect(terminal.writes.map((w) => w.text)).toEqual(["server"]);
  });

  it("explains when it cannot isolate the output", async () => {
    const { text } = await call("run_command", { command: "clear" });
    expect(text).toContain("Could not tell where the new output starts");
  });

  it("rejects invalid patterns before typing anything", async () => {
    const { text, isError } = await call("run_command", { command: "server", wait_for: "(" });
    expect(isError).toBe(true);
    expect(text).toMatch(/Invalid regular expression/);
    expect(terminal.writes).toEqual([]);
  });

  it("reports unknown sessions", async () => {
    const { text, isError } = await call("run_command", { command: "ls", session_id: "nope" });
    expect(isError).toBe(true);
    expect(text).toMatch(/No iTerm2 session has id nope/);
  });

  it("sends progress notifications while it waits", async () => {
    const progress: number[] = [];
    await client.callTool({ name: "run_command", arguments: { command: "slow 1300" } }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    });
    expect(progress.length).toBeGreaterThanOrEqual(1);
  });
});

describe("interactive input", () => {
  it("send_text drives a REPL and shows the reply", async () => {
    await call("send_text", { text: "python3", wait_seconds: 0 });
    const { text } = await call("send_text", { text: "1+1", wait_seconds: 2 });
    expect(text).toContain("Screen output since then:");
    expect(text.split("\n\n")[1]).toBe(">>> 1+1\n2\n>>>");
    expect(terminal.writes.at(-1)).toEqual({ id: work.info.id, text: "1+1", newline: true });
  });

  it("send_text can skip Enter and waiting", async () => {
    const { text } = await call("send_text", { text: "partial", press_enter: false, wait_seconds: 0 });
    expect(text).toMatch(/^Sent to "work"/);
    expect(terminal.writes).toEqual([{ id: work.info.id, text: "partial", newline: false }]);
  });

  it("send_keys interrupts a running program", async () => {
    await call("run_command", { command: "server", wait_for: "listening" });
    const { text, isError } = await call("send_keys", { keys: ["ctrl+c"] });
    expect(isError).toBe(false);
    expect(terminal.writes.at(-1)).toEqual({ id: work.info.id, text: "\x03", newline: false });
    expect(text).toContain("^C");
    expect(work.program).toBeNull();
  });

  it("send_keys rejects unknown key names", async () => {
    const { text, isError } = await call("send_keys", { keys: ["ctrl+c", "warp"] });
    expect(isError).toBe(true);
    expect(text).toMatch(/Unknown key "warp"/);
    expect(terminal.writes).toEqual([]);
  });

  it("will not send keys to its own terminal", async () => {
    const { isError } = await call("send_keys", { keys: ["enter"], session_id: own.info.id });
    expect(isError).toBe(true);
  });
});

describe("read_output and wait_for_output", () => {
  it("reads the last lines with the session status", async () => {
    await call("run_command", { command: "echo one" });
    const { text } = await call("read_output", { lines: 2 });
    expect(text).toContain("Status: idle at the shell prompt");
    expect(text).toMatch(/\[\.\.\. \d+ earlier lines omitted\]\none\n~ %$/);
  });

  it("can read its own terminal, and says so", async () => {
    const { text, isError } = await call("read_output", { session_id: own.info.id });
    expect(isError).toBe(false);
    expect(text).toContain("this is the terminal you are running in");
  });

  it("waits for a pattern in output that started with the last input", async () => {
    await call("send_text", { text: "server", wait_seconds: 0 });
    const matched = await call("wait_for_output", { pattern: "LISTENING", ignore_case: true });
    expect(matched.text).toMatch(/^Output matched/);
    expect(matched.text).toContain(`${PROMPT} server\nlistening on 3000`);

    // The banner is already there, so matching it again is immediate.
    const again = await call("wait_for_output", { pattern: "listening" });
    expect(again.text).toMatch(/^Output matched/);

    const timeout = await call("wait_for_output", { timeout_seconds: 1 });
    expect(timeout.text).toMatch(/^Still running after 1\.0s: node server\.js/);
  });

  it("waits for a running command to finish", async () => {
    await call("run_command", { command: "slow 2000", timeout_seconds: 1 });
    const { text } = await call("wait_for_output", { timeout_seconds: 5 });
    expect(text).toMatch(/^Finished\./);
    expect(text).toContain(`${PROMPT} slow 2000\nslow done`);
  });
});

describe("creating and managing sessions", () => {
  it("create_tab waits for the prompt and returns the new session", async () => {
    terminal.startupMs = 60;
    const { text, isError } = await call("create_tab", { name: "tests", profile: "Work" });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Opened a new tab\./);
    expect(text).not.toContain("has not shown a prompt");
    const info = JSON.parse(text.slice(text.indexOf("{")));
    expect(info).toMatchObject({ name: "tests", profile: "Work", focused: true, is_self: false, status: "idle at the shell prompt" });
    const run = await call("run_command", { command: "echo in tab", session_id: info.session_id });
    expect(run.text).toContain("in tab");
  });

  it("create_window notes a shell that is slow to start", async () => {
    terminal.startupMs = 5000;
    const { text } = await call("create_window");
    expect(text).toMatch(/^Opened a new window\./);
    expect(text).toContain("The shell has not shown a prompt yet");
  });

  it("split_pane may split the assistant's own terminal", async () => {
    terminal.focusedId = own.info.id;
    const { text, isError } = await call("split_pane", { direction: "horizontal" });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Split "claude" .* top and bottom\./);
    expect(JSON.parse(text.slice(text.indexOf("{")))).toMatchObject({ pane_index: 1, is_self: false });
  });

  it("focus_session selects a session", async () => {
    await call("focus_session", { session_id: own.info.id });
    expect(terminal.focusedId).toBe(own.info.id);
  });

  it("close_session protects running programs and its own terminal", async () => {
    await call("run_command", { command: "server", wait_for: "listening" });
    const busy = await call("close_session", { session_id: work.info.id });
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/still running node server\.js/);

    const forced = await call("close_session", { session_id: work.info.id, force: true });
    expect(forced.text).toBe(`Closed session ${work.info.id}.`);

    const mine = await call("close_session", { session_id: own.info.id });
    expect(mine.isError).toBe(true);
    expect(terminal.closed).toEqual([work.info.id]);
  });

  it("close_session notices when iTerm2 keeps the session open", async () => {
    terminal.stubborn.add(work.info.id);
    const { text } = await call("close_session", { session_id: work.info.id });
    expect(text).toMatch(/still open; iTerm2 may be asking the user to confirm/);
  });
});
