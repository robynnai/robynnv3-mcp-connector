import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

/**
 * COS-PLUGIN-001 (†): the app's connected-app read path still persists the
 * organization's connector policy before executing a read (getOrCreatePolicy
 * inserts a default connector_policies row or rewrites allowed_actions,
 * re-adding read actions an admin removed), so robynn_query_connected_app is
 * not read-only yet. Flip to false once P07 removes that write, and set the
 * tool's currentHints/proposedHints to hintsAfterP07 in
 * contracts/tool-route-map.json in the same change. requiredScope does not
 * depend on this flag (open decision D-A).
 */
export const CONNECTED_APP_READS_PERSIST_POLICY = true;

const POLICY_EFFECT = CONNECTED_APP_READS_PERSIST_POLICY
  ? " Robynn logs the call and may create or update your organization's connector policy for that app, re-enabling its curated read actions."
  : " Read-only; Robynn logs the call.";

export function registerConnectorTools(server: McpServer, client: RobynnClient) {
  server.registerTool(
    "robynn_connected_apps",
    {
      ...toolMetadata("List Connected Apps", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "List the connected apps available to your Robynn organization, with each app's default connection and curated read actions. Read-only; uses Robynn's stored connection details and does not contact the apps. Use the connected-app tools first for provider-specific operational questions such as CRM counts, pipeline state, HighLevel contacts, or repository facts; use research tools for strategy and market analysis.",
    },
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

  server.registerTool(
    "robynn_connected_app_capabilities",
    {
      ...toolMetadata("Get Connected App Capabilities", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Describe the curated read actions Robynn supports for one connected app, with JSON-schema-like input metadata and example prompts. Read-only; does not contact the app. Use this before guessing actions, then call robynn_query_connected_app. For HighLevel, provider_key is highlevel and read actions include highlevel.list_contacts, highlevel.list_opportunities, highlevel.list_conversations, highlevel.list_conversation_messages, highlevel.list_email_templates, and highlevel.list_bulk_action_campaigns.",
      inputSchema: {
        provider_key: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Connected app provider key, for example hubspot, highlevel, or github.",
          ),
      },
    },
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

  server.registerTool(
    "robynn_query_connected_app",
    {
      ...toolMetadata("Query a Connected App", {
        readOnlyHint: !CONNECTED_APP_READS_PERSIST_POLICY,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      }),
      description:
        `Run a curated read action against one of your organization's connected apps (for example HubSpot, HighLevel, or GitHub) and return live data from that service without changing data in the app.${POLICY_EFFECT} Use robynn_connected_app_capabilities first to discover valid actions and input schema. Treat structuredContent.summary and structuredContent.highlights as the primary answer for text-only clients, and use raw_result only when deeper inspection is needed. HighLevel examples include highlevel.list_contacts, highlevel.list_email_templates, and highlevel.list_bulk_action_campaigns.`,
      inputSchema: {
        provider_key: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Connected app provider key, for example hubspot, highlevel, or github.",
          ),
        action_key: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Curated Robynn read action key, for example hubspot.list_contacts or highlevel.list_contacts.",
          ),
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
    },
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
