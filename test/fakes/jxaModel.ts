import vm from "node:vm";
import { JXA_SOURCE } from "../../src/jxa.js";

/**
 * A stand-in for iTerm2 as JXA sees it: properties are called as functions
 * (`session.tty()`), writable properties can also be assigned
 * (`session.name = "x"`), and commands are methods taking a parameter record.
 * Only what the bridge script uses is modelled.
 */

let nextId = 1;

function appleEventError(message: string, errorNumber: number): Error {
  return Object.assign(new Error(message), { errorNumber });
}

export class FakeSession {
  readonly calls: string[] = [];
  readonly written: string[] = [];
  closed = false;
  private sessionName: string;

  constructor(
    readonly tab: FakeTab,
    readonly guid = `SESSION-${nextId++}`,
    public contentsText = "",
    public cwd: string | null = "/Users/me",
    public profile = "Default",
    public shellPrompt = false,
  ) {
    this.sessionName = `zsh (${guid})`;
  }

  readonly ttyPath = `/dev/ttys${String(nextId++).padStart(3, "0")}`;

  id() {
    return this.guid;
  }
  get name(): () => string {
    return () => this.sessionName;
  }
  set name(value: string) {
    this.calls.push(`set name ${value}`);
    this.sessionName = value;
  }
  tty() {
    return this.ttyPath;
  }
  contents() {
    return this.contentsText;
  }
  isAtShellPrompt() {
    return this.shellPrompt;
  }
  profileName() {
    return this.profile;
  }
  columns() {
    return 80;
  }
  rows() {
    return 24;
  }
  variable(params: { named: string }) {
    return params.named === "path" ? this.cwd : null;
  }
  write(params: { text: string; newline?: boolean }) {
    this.written.push(params.text + (params.newline === false ? "" : "\r"));
  }
  select() {
    this.calls.push("select");
    this.tab.current = this;
  }
  close() {
    this.closed = true;
    this.tab.list.splice(this.tab.list.indexOf(this), 1);
  }
  private split(how: string, profile = "Default") {
    this.calls.push(how);
    const created = new FakeSession(this.tab, undefined, "", this.cwd, profile);
    this.tab.list.splice(this.tab.list.indexOf(this) + 1, 0, created);
    return created;
  }
  splitVerticallyWithDefaultProfile() {
    return this.split("split vertically");
  }
  splitHorizontallyWithDefaultProfile() {
    return this.split("split horizontally");
  }
  splitVertically(params: { withProfile: string }) {
    return this.split("split vertically", this.tab.window.app.checkProfile(params.withProfile));
  }
  splitHorizontally(params: { withProfile: string }) {
    return this.split("split horizontally", this.tab.window.app.checkProfile(params.withProfile));
  }
}

export class FakeTab {
  readonly list: FakeSession[] = [];
  current: FakeSession | null = null;
  selected = 0;

  constructor(readonly window: FakeWindow) {}

  sessions() {
    return this.list.slice();
  }
  currentSession() {
    return this.current ?? this.list[0] ?? null;
  }
  select() {
    this.selected++;
    this.window.current = this;
  }
  addSession(profile = "Default"): FakeSession {
    const session = new FakeSession(this, undefined, "", "/Users/me", profile);
    this.list.push(session);
    this.current ??= session;
    return session;
  }
}

export class FakeWindow {
  readonly list: FakeTab[] = [];
  current: FakeTab | null = null;
  selected = 0;

  constructor(
    readonly app: FakeApp,
    readonly windowId: number,
  ) {}

  id() {
    return this.windowId;
  }
  tabs() {
    return this.list.slice();
  }
  currentTab() {
    return this.current;
  }
  currentSession() {
    return this.current?.currentSession() ?? null;
  }
  select() {
    this.selected++;
    this.app.front = this;
  }
  addTab(profile = "Default"): FakeTab {
    const tab = new FakeTab(this);
    tab.addSession(profile);
    this.list.push(tab);
    this.current = tab;
    return tab;
  }
  createTabWithDefaultProfile() {
    return this.addTab();
  }
  createTab(params: { withProfile: string }) {
    return this.addTab(this.app.checkProfile(params.withProfile));
  }
}

export class FakeApp {
  isRunning = true;
  readonly list: FakeWindow[] = [];
  front: FakeWindow | null = null;
  activations = 0;
  profiles = ["Default", "Work"];
  /** Whether iTerm2 opens a window by itself when launched. */
  opensWindowOnLaunch = true;
  private nextWindowId = 1000;

  running() {
    return this.isRunning;
  }
  activate() {
    this.activations++;
    if (!this.isRunning) {
      this.isRunning = true;
      if (this.opensWindowOnLaunch) this.addWindow();
    }
  }
  currentWindow() {
    return this.front;
  }
  readonly windows = Object.assign(() => this.list.slice(), {
    byId: (id: number) =>
      this.list.find((w) => w.windowId === id) ?? {
        id: () => {
          throw appleEventError("Can't get object.", -1728);
        },
      },
  });
  addWindow(profile = "Default"): FakeWindow {
    const window = new FakeWindow(this, this.nextWindowId++);
    window.addTab(profile);
    this.list.push(window);
    this.front = window;
    return window;
  }
  createWindowWithDefaultProfile() {
    return this.addWindow();
  }
  createWindowWithProfile(profile: string) {
    return this.addWindow(this.checkProfile(profile));
  }
  checkProfile(profile: string): string {
    if (!this.profiles.includes(profile)) throw appleEventError(`No profile named ${profile}`, -2700);
    return profile;
  }
  allSessions(): FakeSession[] {
    return this.list.flatMap((w) => w.list.flatMap((t) => t.list));
  }
}

export interface JxaReply {
  ok: boolean;
  result?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  code?: string;
  error?: string;
  errorNumber?: number | null;
}

/**
 * Runs the exact script the server hands to osascript, in a fresh V8 context
 * whose only globals are the JXA ones it relies on.
 */
export function runJxa(app: FakeApp | (() => never), request: unknown): JxaReply {
  const context = vm.createContext({
    Application: (bundleId: string) => {
      if (bundleId !== "com.googlecode.iterm2") throw new Error(`unexpected bundle id ${bundleId}`);
      return typeof app === "function" ? app() : app;
    },
    delay: () => {},
  });
  vm.runInContext(JXA_SOURCE, context);
  const raw = (context.run as (argv: string[]) => string)([typeof request === "string" ? request : JSON.stringify(request)]);
  return JSON.parse(raw) as JxaReply;
}
