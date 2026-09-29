# iTerm2 MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant such as Claude Code or Claude Desktop work in
[iTerm2](https://iterm2.com) on your Mac. It can run commands and read their output, type into interactive programs,
press keys like Ctrl-C, and open tabs, windows and split panes, all in real iTerm2 sessions you can watch and take over.

- **Real sessions:** commands run in your iTerm2, with your shell, environment, ssh sessions and credentials. You can
  watch as it works.
- **Clean output:** `run_command` waits for the command to finish and returns only what that command printed, not
  the whole scrollback.
- **Safe defaults:** it never types into the terminal the assistant itself is running in, never types a command into a
  busy program such as vim or a running server, and won't close a session that is still running something unless
  asked to.

## Requirements

- macOS with iTerm2 3.x
- Node.js 20 or newer

## Install

Clone and build it (`npm install` also compiles the TypeScript into `dist/`):

```sh
git clone https://github.com/cigarette1991/iTerm-MCP.git
cd iTerm-MCP
npm install
```

Then register it with your MCP client.

**Claude Code**

```sh
claude mcp add --scope user iterm2 -- node /absolute/path/to/iTerm-MCP/dist/index.js
```

Or skip the clone and let npx fetch and build it from GitHub:

```sh
claude mcp add --scope user iterm2 -- npx -y github:cigarette1991/iTerm-MCP
```

**Claude Desktop, Cursor, and other clients.** Add this to the client's MCP configuration. For Claude Desktop that
is `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "iterm2": {
      "command": "node",
      "args": ["/absolute/path/to/iTerm-MCP/dist/index.js"]
    }
  }
}
```

GUI apps don't inherit your shell's `PATH`, so if `node` comes from nvm or Homebrew, put the absolute path from
`which node` in `command`.

### macOS permission

The server drives iTerm2 through Apple Events, so the first time it runs, macOS asks whether the app that started it
(your terminal, Claude, or your editor) may control iTerm2. Click **OK**. If you clicked **Don't Allow**, turn it back
on in **System Settings → Privacy & Security → Automation**.

## Tools

| Tool | What it does |
| --- | --- |
| `list_sessions` | Lists every window, tab and pane with its `session_id`, name, tty, working directory, size and status (idle or what it is running). `is_self` marks the assistant's own terminal. |
| `run_command` | Types a command, presses Enter, waits for it to finish and returns its output. `wait_for` (a regex) returns early, for example once a dev server prints "ready". `timeout_seconds` defaults to 30; a command that is still running keeps running. |
| `send_text` | Types text, optionally pressing Enter, and returns what appeared once the output settles. For REPLs, prompts, ssh sessions and other interactive programs. |
| `send_keys` | Presses keys in order: `ctrl+c`, `ctrl+d`, `escape`, `tab`, `enter`, arrow keys, `page_up`, `f1`–`f12`, `alt+<key>`, single characters, and so on. |
| `read_output` | Returns the last N lines of a session, scrollback included, and whether it is idle or running something. |
| `wait_for_output` | Waits until new output matches a regex or, without one, until the running command finishes. |
| `create_tab` | Opens a tab with a fresh shell, optionally with a given profile and name, and waits for its prompt. |
| `create_window` | Opens a window with a fresh shell, starting iTerm2 if needed. |
| `split_pane` | Splits a session side by side (`vertical`) or top and bottom (`horizontal`). |
| `focus_session` | Brings a session's window, tab and pane to the front. |
| `close_session` | Closes a session. It refuses while a program is running there unless `force` is set. |

Every tool that targets a session takes an optional `session_id`. Without it, the tool uses the focused session of the
frontmost iTerm2 window.

### If the assistant runs inside iTerm2

When Claude Code runs in an iTerm2 session, that session is its own conversation, and typing into it would feed text
straight back into the chat. The server detects this through `$ITERM_SESSION_ID` and the process's tty. It then
refuses to type there, and tells the assistant to open a split pane or tab instead. Splitting your own session with
`split_pane` is a good way to watch the assistant work next to the conversation.

## How it works

- **Talking to iTerm2.** Each operation runs a small JavaScript for Automation (JXA) script through `osascript`, using
  iTerm2's AppleScript dictionary. No iTerm2 settings need to change: the Python API is not required.
- **Knowing when a command is done.** The server looks at the session's tty with `ps`. When nothing but the
  interactive shell is in the foreground and the screen has stopped changing, the command has finished. If
  [iTerm2 shell integration](https://iterm2.com/documentation-shell-integration.html) is installed, its "at prompt"
  signal is used as well, which also catches shell builtins and functions that run without a child process.
- **Returning only new output.** Before typing, the server remembers the last few lines on screen. Afterwards it finds
  those lines again and returns everything from the prompt line onward. This still works when old lines have scrolled
  out of the scrollback. If the screen was cleared, it falls back to the end of the buffer and says so.
- **Long waits.** While waiting, the server sends MCP progress notifications and stops when the request is cancelled.

## Limitations

- Output is read from the screen, so there is no exit code. Append `; echo "exit=$?"` to a command when you need one.
- Full-screen programs (vim, less, htop) work through `send_keys` and `read_output`, but what you read back is the
  rendered screen.
- Completion detection watches local processes. Inside ssh, tmux or a REPL, the foreground program is always busy,
  so use `send_text` and `wait_for_output` with a pattern there.
- Anything the assistant types runs with your permissions. Keep your MCP client's per-tool approval on for
  `run_command`, `send_text` and `send_keys` unless you trust the task.

## Troubleshooting

- **"macOS did not allow this process to control iTerm2"**: grant the Automation permission described above.
- **"iTerm2 did not respond in time"**: iTerm2 is probably showing a dialog, such as a confirmation to close a
  session with a running job.
- **Talk to the bridge directly** to see what iTerm2 returns:

  ```sh
  npm run -s print-jxa > /tmp/iterm-bridge.js
  osascript -l JavaScript /tmp/iterm-bridge.js '{"op":"list"}'
  ```

## Development

```sh
npm install        # installs dependencies and builds dist/
npm run typecheck
npm test           # runs on Linux too; macOS-only checks are skipped there
npm run build
```

The tests run the exact JXA script against a model of iTerm2's scripting objects, drive the MCP tools end to end
against a simulated terminal, and check the `ps`-based job detection on a real pseudo-terminal. CI also runs them on
macOS, where the bridge is executed by the real `osascript` and compiled with `osacompile`.
