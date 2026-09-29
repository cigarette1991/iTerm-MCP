import { controllingTty, normalizeTty, type ProcessLister } from "./processes.js";

/**
 * When the MCP client (for example Claude Code) runs inside iTerm2, one of the
 * sessions is the client's own terminal. Typing into it would inject text into
 * the conversation itself, so the server identifies that session and refuses
 * to write to it.
 */
export interface SelfIdentity {
  /** iTerm2 session id taken from $ITERM_SESSION_ID. */
  sessionId: string | null;
  /** Normalised name of the terminal this process (or an ancestor) is attached to. */
  tty: string | null;
}

/** Extracts the session UUID from ITERM_SESSION_ID, which looks like "w0t1p0:6E1A...". */
export function sessionIdFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const value of [env.ITERM_SESSION_ID, env.TERM_SESSION_ID]) {
    const match = value ? /^w\d+t\d+p\d+:(.+)$/.exec(value) : null;
    if (match) return match[1];
  }
  return null;
}

export async function detectSelf(
  env: NodeJS.ProcessEnv,
  processes: ProcessLister,
  pid: number,
): Promise<SelfIdentity> {
  let tty: string | null = null;
  try {
    tty = controllingTty(await processes(), pid);
  } catch {
    // ps unavailable: rely on the environment variable alone.
  }
  return { sessionId: sessionIdFromEnv(env), tty };
}

export function isSelf(session: { id: string; tty: string }, self: SelfIdentity): boolean {
  if (self.sessionId && session.id.toLowerCase() === self.sessionId.toLowerCase()) return true;
  return self.tty !== null && self.tty !== "" && normalizeTty(session.tty) === self.tty;
}
