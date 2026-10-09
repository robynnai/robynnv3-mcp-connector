import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { isSafePathId, toErrorResult, toSuccessResult, toolMetadata } from "./util";

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
  server.registerTool(
    "robynn_thread_upsert",
    {
      ...toolMetadata("Save a Conversation Thread", {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Create or update a Robynn thread for an external agent (Hermes) conversation so teammates can see it in Robynn. Keyed by hermes_host_id + hermes_session_id: calling again with the same ids updates that thread's title and owner. Call once per conversation (again if the title improves). Returns { id } — keep it and pass it to robynn_thread_append.",
      inputSchema: {
        hermes_host_id: z.string().describe("Stable identifier for the Hermes host (hostname, Fly app id, etc.)"),
        hermes_session_id: z.string().describe("Stable identifier for the current Hermes session."),
        platform: PLATFORM_ENUM.describe("Originating surface."),
        platform_user: z.string().optional().describe("Platform-native handle, e.g. '@madhukar'."),
        title: z.string().optional().describe("Short human-readable title for the thread."),
      },
    },
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

  server.registerTool(
    "robynn_thread_append",
    {
      ...toolMetadata("Append to a Conversation Thread", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      }),
      description:
        "Append one message turn (user, assistant, tool, or system) to a thread from robynn_thread_upsert so teammates see it in Robynn. Call after each turn; every call adds a new message, so retries create duplicates.",
      inputSchema: {
        thread_id: z.string().describe("Thread id returned by robynn_thread_upsert."),
        role: ROLE_ENUM.describe("Message origin."),
        content: z.string().describe("Message body. Plain text."),
        tool_calls: z.array(z.record(z.unknown())).optional().describe("Optional raw tool calls made during this turn."),
        tool_name: z.string().optional().describe("If role=tool, the tool name."),
        tokens_in: z.number().int().optional().describe("Optional input token count for this turn."),
        tokens_out: z.number().int().optional().describe("Optional output token count for this turn."),
        latency_ms: z.number().int().optional().describe("Optional turn latency in milliseconds."),
      },
    },
    async (args) => {
      if (!isSafePathId(args.thread_id)) {
        return toErrorResult("Invalid thread_id.");
      }

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

  server.registerTool(
    "robynn_memory_write",
    {
      ...toolMetadata("Save a Memory", {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      }),
      description:
        "Save a durable memory to Robynn under scope + key for recall across sessions and hosts. Overwrites any existing memory with the same scope and key. Do NOT use for operating rules.",
      inputSchema: {
        scope: SCOPE_ENUM.describe("org = visible to all org members; user = tied to the caller; session = not isolated per conversation and unsupported for plugin (OAuth) connections."),
        key: z.string().describe("Stable memory key, e.g. 'h2_theme', 'favourite_voice_example'."),
        value: z.string().describe("Memory body (plain text)."),
      },
    },
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

  server.registerTool(
    "robynn_memory_get",
    {
      ...toolMetadata("Get a Memory", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Fetch a durable memory by scope + key. Returns null if no such memory exists. Read-only.",
      inputSchema: {
        scope: SCOPE_ENUM.describe("Scope the memory was saved under: org, user, or session (session is unsupported for plugin connections)."),
        key: z.string().describe("Memory key used when it was saved."),
      },
    },
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

  server.registerTool(
    "robynn_memory_search",
    {
      ...toolMetadata("Search Memories", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Find Robynn memories by intent using hybrid vector + keyword search. Use when you don't know the exact memory key — e.g. 'what did we decide about Q2 go-to-market?'. Returns up to `limit` ranked rows. Read-only.",
      inputSchema: {
        query: z.string().describe("Natural-language search query."),
        scope: SCOPE_ENUM.optional().describe("Restrict to org|user|session scope (session is unsupported for plugin connections); omit to search all scopes."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10, cap 50)."),
      },
    },
    async (args) => {
      try {
        const result = await client.searchHermesMemory(args);
        return toSuccessResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_memory_search failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
