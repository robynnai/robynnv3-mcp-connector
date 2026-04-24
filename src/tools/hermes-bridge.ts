import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

const PLATFORM_ENUM = z.enum([
  "cli",
  "telegram",
  "slack",
  "whatsapp",
  "discord",
  "signal",
  "email",
  "sms",
  "cron",
  "other",
]);

const ROLE_ENUM = z.enum(["user", "assistant", "tool", "system"]);
const SCOPE_ENUM = z.enum(["org", "user", "session"]);

/**
 * Registers thread-persistence + durable-memory tools. These are what make
 * Hermes (and any MCP client) a multiplayer participant: conversations and
 * facts are mirrored into Robynn so every org teammate can see them in the
 * Rory UI.
 */
export function registerHermesBridgeTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_thread_upsert",
    "Create or update a Hermes-originated thread in Robynn. Call this once per conversation (and re-call if the title improves). Returns { id } — keep it and pass to robynn_thread_append.",
    {
      hermes_host_id: z.string().describe("Stable identifier for the Hermes host (hostname, Fly app id, etc.)"),
      hermes_session_id: z.string().describe("Stable identifier for the current Hermes session."),
      platform: PLATFORM_ENUM.describe("Originating surface."),
      platform_user: z.string().optional().describe("Platform-native handle, e.g. '@madhukar'."),
      title: z.string().optional().describe("Short human-readable title for the thread."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const result = await client.upsertHermesThread(args);
        return toSuccessResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_thread_upsert failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.tool(
    "robynn_thread_append",
    "Append a single message turn to a Hermes thread so teammates see it in Rory UI. Call after each turn (user, assistant, or tool).",
    {
      thread_id: z.string().describe("Thread id returned by robynn_thread_upsert."),
      role: ROLE_ENUM.describe("Message origin."),
      content: z.string().describe("Message body. Plain text."),
      tool_calls: z.array(z.record(z.unknown())).optional().describe("Optional raw tool calls made during this turn."),
      tool_name: z.string().optional().describe("If role=tool, the tool name."),
      tokens_in: z.number().int().optional(),
      tokens_out: z.number().int().optional(),
      latency_ms: z.number().int().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const { thread_id, ...rest } = args;
        const result = await client.appendHermesMessage(thread_id, rest);
        return toSuccessResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_thread_append failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.tool(
    "robynn_memory_write",
    "Persist a durable memory to Robynn (org/user/session scope). Use for facts the agent should recall across sessions and hosts. Do NOT use for operating rules.",
    {
      scope: SCOPE_ENUM.describe("org = visible to all org members; user = tied to caller; session = scoped to this thread."),
      key: z.string().describe("Stable memory key, e.g. 'h2_theme', 'favourite_voice_example'."),
      value: z.string().describe("Memory body (plain text)."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const result = await client.writeHermesMemory(args);
        return toSuccessResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_memory_write failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.tool(
    "robynn_memory_get",
    "Fetch a durable memory by scope + key. Returns null if no such memory exists.",
    {
      scope: SCOPE_ENUM,
      key: z.string(),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ scope, key }) => {
      try {
        const result = await client.getHermesMemory(scope, key);
        return toSuccessResult((result ?? { value: null }) as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_memory_get failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
