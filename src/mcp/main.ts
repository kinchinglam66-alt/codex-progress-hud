import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpProgressClient } from "./report-client.js";
import {
  createToolHandlers,
  progressReportSchema,
  taskOutcomeSchema
} from "./tools.js";

const server = new McpServer({ name: "codex-progress-hud", version: "0.1.0" });
const handlers = createToolHandlers(new HttpProgressClient());

server.registerTool(
  "progress_report",
  {
    title: "Report task progress",
    description:
      "Report a concise task phase, optional measured progress, ETA range, or waiting state to the local Progress HUD. Never include secrets, prompts, source code, reasoning, or command output.",
    inputSchema: progressReportSchema
  },
  (input) => handlers.progressReport(input)
);

server.registerTool(
  "task_outcome",
  {
    title: "Report task outcome",
    description:
      "Report a terminal semantic outcome. Set verified only when validation evidence actually ran and passed.",
    inputSchema: taskOutcomeSchema
  },
  (input) => handlers.taskOutcome(input)
);

server.registerTool(
  "task_status",
  {
    title: "Read HUD task status",
    description: "Read the current local Progress HUD snapshot."
  },
  () => handlers.taskStatus()
);

await server.connect(new StdioServerTransport());

