import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

export function registerConnectorTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_connected_apps",
    "List connected apps available to the Robynn organization, including the default connection and curated read-only actions.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const result = await client.getConnectedAppCapabilities();

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to load connected apps");
        }

        const providers = result.data.providers || [];

        return toSuccessResult(
          {
            count: providers.length,
            providers,
          },
          providers.length > 0
            ? `Found ${providers.length} connected apps with curated read actions.`
            : "No connected apps with curated read actions are available.",
        );
      } catch (err) {
        return toErrorResult(
          `Error loading connected apps: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.tool(
    "robynn_connected_app_capabilities",
    "Describe the curated read-only actions Robynn supports for a connected app, including JSON-schema-like input metadata and example prompts.",
    {
      provider_key: z
        .string()
        .trim()
        .min(1)
        .describe("Connected app provider key, for example hubspot or github."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ provider_key }) => {
      try {
        const result = await client.getConnectedAppCapabilities(provider_key);

        if (!result.success || !result.data) {
          return toErrorResult(
            result.error || "Failed to load connected app capabilities",
          );
        }

        const provider = result.data.providers?.[0];
        if (!provider) {
          return toErrorResult(
            `No connected app capabilities found for provider: ${provider_key}`,
          );
        }

        return toSuccessResult(
          provider as unknown as Record<string, unknown>,
          `Loaded ${provider.read_actions.length} curated read actions for ${provider.display_name}.`,
        );
      } catch (err) {
        return toErrorResult(
          `Error loading connected app capabilities: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.tool(
    "robynn_query_connected_app",
    "Execute a curated read-only action against a connected app. Use robynn_connected_app_capabilities first to discover valid actions and input schema.",
    {
      provider_key: z
        .string()
        .trim()
        .min(1)
        .describe("Connected app provider key, for example hubspot or github."),
      action_key: z
        .string()
        .trim()
        .min(1)
        .describe("Curated Robynn read action key, for example hubspot.list_contacts."),
      payload: z
        .record(z.unknown())
        .optional()
        .describe("Action payload matching the JSON-schema-like input metadata returned by robynn_connected_app_capabilities."),
      connection_id: z
        .string()
        .uuid()
        .optional()
        .describe("Optional specific connection id. Omit to use the provider default."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ provider_key, action_key, payload, connection_id }) => {
      try {
        const result = await client.readConnectedApp({
          provider_key,
          action_key,
          payload: payload || {},
          connection_id,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to query connected app");
        }

        return toSuccessResult(
          result.data as unknown as Record<string, unknown>,
          result.data.summary,
        );
      } catch (err) {
        return toErrorResult(
          `Error querying connected app: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
