#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OsascriptITerm } from "./iterm.js";
import { listProcesses } from "./processes.js";
import { detectSelf } from "./self.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("iterm2-mcp controls iTerm2 through AppleScript and only runs on macOS.");
    process.exit(1);
  }

  const server = createServer({
    iterm: new OsascriptITerm(),
    processes: listProcesses,
    self: () => detectSelf(process.env, listProcesses, process.pid),
  });
  await server.connect(new StdioServerTransport());
  console.error("iterm2-mcp is running on stdio");
}

main().catch((error) => {
  console.error("iterm2-mcp failed to start:", error);
  process.exit(1);
});
