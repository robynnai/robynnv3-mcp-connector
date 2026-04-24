#!/usr/bin/env node
import { Command } from 'commander';
import { readConfig, writeConfig } from './config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { RobynnClient } from '../robynn-client';
import { registerContextTools } from '../tools/context';
import { registerStatusTools } from '../tools/status';
import { registerContentTools } from '../tools/content';
import { registerResearchTools } from '../tools/research';
import { registerAssistTools } from '../tools/assist';
import { registerConversationTools } from '../tools/conversations';
import { registerRunTools } from '../tools/runs';
import { registerGeoTools } from '../tools/geo';
import { registerBattlecardTools } from '../tools/battlecard';
import { registerSeoTools } from '../tools/seo';
import { registerBrandBookTools } from '../tools/brand-book';
import { registerCampaignTools } from '../tools/campaign';
import { registerCmoAgentTools } from '../tools/cmo-agent';
import { registerWebsiteTools } from '../tools/website';
import { registerConnectorTools } from '../tools/connectors';
import { registerHermesBridgeTools } from '../tools/hermes-bridge';
import { registerConnectorActionTools } from '../tools/connector-act';
import { installOpenClaw } from './install-openclaw';
import type { RobynnApiResponse } from '../types';
import { APP_VERSION } from '../version';

const program = new Command();
const DEFAULT_API_URL = process.env.ROBYNN_API_BASE_URL || 'https://robynn.ai';

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getConfiguredApiKey(): string {
  const apiKey = readConfig().apiKey;
  if (!apiKey) {
    exitWithError('❌ Not authenticated. Run `robynn init <key>` first.');
  }
  return apiKey;
}

function requireResponseData<T>(
  response: RobynnApiResponse<T>,
  actionName: string,
): T {
  if (!response.data) {
    throw new Error(`${actionName} returned no data.`);
  }
  return response.data;
}

program
  .name('robynn')
  .description('Robynn AI Official CLI & Local MCP Bridge')
  .version(APP_VERSION);

program
  .command('init')
  .description('Initialize the CLI with your Robynn Organization API Key')
  .argument('<key>', 'Your Organization API Key (rbo_...)')
  .action((key: string) => {
    const config = readConfig();
    config.apiKey = key;
    writeConfig(config);
    console.log(`✅ API Key saved successfully to ~/.robynn/config.json!`);
  });

const auth = program.command('auth').description('Authentication commands');
auth
  .command('login')
  .description('Login with an API Key (alias for init)')
  .argument('<key>', 'Your Organization API Key (rbo_...)')
  .action((key: string) => {
    const config = readConfig();
    config.apiKey = key;
    writeConfig(config);
    console.log(`✅ Logged in successfully. Key saved.`);
  });

auth
  .command('status')
  .action(() => {
    const config = readConfig();
    if (config.apiKey) {
      console.log(`✅ Authenticated with API Key: ${config.apiKey.substring(0, 8)}...`);
    } else {
      exitWithError(`❌ Not authenticated. Run 'robynn init <key>' first.`);
    }
  });

const install = program.command('install').description('Configure local agent runtimes');

install
  .command('openclaw')
  .description('Configure OpenClaw to launch the local Robynn MCP bridge')
  .action(() => {
    const config = readConfig();
    const result = installOpenClaw({
      apiKeyConfigured: Boolean(config.apiKey),
    });

    if (result.status === 'manual-required') {
      exitWithError(result.instructions || 'OpenClaw install failed.');
    }

    const action =
      result.status === 'installed'
        ? 'Installed'
        : result.status === 'updated'
          ? 'Updated'
          : 'OpenClaw already has';

    console.log(`${action} MCP server entry at ${result.configPath}`);
    console.log('Configured OpenClaw server: robynn -> `robynn mcp`');
    if (result.nextStep) {
      console.log(`Next step: run \`${result.nextStep}\``);
    } else {
      console.log('Robynn API key already configured.');
    }
  });

// --- MCP Bridge ---
program
  .command('mcp')
  .description('Start the local Stdio MCP Server')
  .action(async () => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    const server = new McpServer({
      name: "Robynn (Local CLI)",
      version: APP_VERSION,
    });

    // Register all tools just like the Cloudflare worker
    registerContextTools(server, client);
    registerStatusTools(server, client);
    registerContentTools(server, client);
    registerResearchTools(server, client);
    registerAssistTools(server, client);
    registerConversationTools(server, client);
    registerRunTools(server, client);
    registerGeoTools(server, client);
    registerBattlecardTools(server, client);
    registerSeoTools(server, client);
    registerBrandBookTools(server, client);
    registerCmoAgentTools(server, client);
    registerCampaignTools(server, client);
    registerWebsiteTools(server, client);
    registerConnectorTools(server, client);
    registerHermesBridgeTools(server, client);
    registerConnectorActionTools(server, client);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Silent startup - Stdio requires clean stdout for JSON-RPC
  });

// --- Helper for formatting ---
function handleOutput(jsonFlag: boolean, result: any, actionName: string) {
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== ${actionName} ===\n`);
    console.dir(result, { depth: null, colors: true });
  }
}

// --- Headless Commands ---
const analyze = program.command('analyze').description('Run market intelligence workflows');

analyze
  .command('geo')
  .description('Run a GEO analysis')
  .requiredOption('-q, --query <text>', 'Search query')
  .option('-c, --category <text>', 'Category (required by backend)')
  .option('--json', 'Output strictly as JSON')
  .action(async (options: { query: string; category?: string; json?: boolean }) => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    try {
      if (!options.json) console.log('⏳ Running GEO analysis... (this may take 1-2 minutes)');
      const res = await client.geoAnalysis({ company_name: options.query, category: options.category || "software" });
      handleOutput(options.json ?? false, res, 'GEO Analysis Result');
    } catch (error: unknown) {
      exitWithError(`Error: ${formatError(error)}`);
    }
  });

analyze
  .command('seo')
  .description('Run an SEO opportunities analysis')
  .requiredOption('-u, --url <url>', 'Website URL')
  .option('--json', 'Output strictly as JSON')
  .action(async (options: { url: string; json?: boolean }) => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    try {
      if (!options.json) console.log('⏳ Running SEO analysis...');
      const res = await client.seoOpportunities({
        company_name: options.url,
        company_url: options.url,
      });
      handleOutput(options.json ?? false, res, 'SEO Opportunities Result');
    } catch (error: unknown) {
      exitWithError(`Error: ${formatError(error)}`);
    }
  });

const brand = program.command('brand').description('Brand context and status');

brand
  .command('context')
  .description('Get the current brand context')
  .option('--json', 'Output strictly as JSON')
  .action(async (options: { json?: boolean }) => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    try {
      const res = await client.getBrandContext('full');
      handleOutput(options.json ?? false, res, 'Brand Context');
    } catch (error: unknown) {
      exitWithError(`Error: ${formatError(error)}`);
    }
  });


const research = program.command('research').description('Research companies and topics');
research
  .command('company')
  .description('Research a company')
  .requiredOption('-q, --query <text>', 'Company name')
  .option('--json', 'Output strictly as JSON')
  .action(async (options: { query: string; json?: boolean }) => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    try {
      if (!options.json) console.log('⏳ Running research on ' + options.query + '...');
      const threadRes = await client.createThread(`Research: ${options.query}`);
      const threadId = requireResponseData(threadRes, 'Thread creation').id;
      const runRes = await client.startRun(threadId, { message: `Research: ${options.query}`, type: "research" });
      const runId = requireResponseData(runRes, 'Run creation').run_id;
      const result = await client.pollRun(runId);
      handleOutput(options.json ?? false, requireResponseData(result, 'Research run').output, 'Research Result');
    } catch (error: unknown) {
      exitWithError(`Error: ${formatError(error)}`);
    }
  });

const content = program.command('content').description('Generate content and draft emails');
content
  .command('email')
  .description('Draft an email')
  .requiredOption('-p, --prompt <text>', 'Email prompt')
  .option('--json', 'Output strictly as JSON')
  .action(async (options: { prompt: string; json?: boolean }) => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    try {
      if (!options.json) console.log('⏳ Drafting email...');
      const threadRes = await client.createThread(`Email Draft`);
      const threadId = requireResponseData(threadRes, 'Thread creation').id;
      const runRes = await client.startRun(threadId, { message: options.prompt, type: "content" });
      const runId = requireResponseData(runRes, 'Run creation').run_id;
      const result = await client.pollRun(runId);
      handleOutput(options.json ?? false, requireResponseData(result, 'Content run').output, 'Draft Email');
    } catch (error: unknown) {
      exitWithError(`Error: ${formatError(error)}`);
    }
  });

const assist = program.command('assist').description('Run a general-purpose Robynn CMO request');
assist
  .requiredOption('-m, --message <text>', 'Assistant request message')
  .option('--thread-id <id>', 'Continue in an existing conversation thread')
  .option('--assistant-id <id>', 'Assistant override hint (cmo_v2, cmo_v3, auto)')
  .option('--route-hint <hint>', 'Routing hint (fast, deep, auto)')
  .option('--requested-capability <capability>', 'Requested capability (article, image, research, general)')
  .option('--claude-skill-slug <slug>', 'Optional Claude skill slug')
  .option('--history-summary <text>', 'Optional summary of prior thread history')
  .option('--memory-enabled', 'Enable backend memory for this run')
  .option('--json', 'Output strictly as JSON')
  .action(async (options: {
    message: string;
    threadId?: string;
    assistantId?: 'cmo_v2' | 'cmo_v3' | 'auto';
    routeHint?: 'fast' | 'deep' | 'auto';
    requestedCapability?: 'article' | 'image' | 'research' | 'general';
    claudeSkillSlug?: string;
    historySummary?: string;
    memoryEnabled?: boolean;
    json?: boolean;
  }) => {
    const client = new RobynnClient(DEFAULT_API_URL, getConfiguredApiKey());
    try {
      if (!options.json) console.log('⏳ Running assist request...');
      const threadRes = options.threadId
        ? { success: true, data: { id: options.threadId } }
        : await client.createThread(`Assist: ${options.message.slice(0, 50)}`);
      const threadId = requireResponseData(threadRes, 'Thread creation').id;
      const runRes = await client.startRun(threadId, {
        message: options.message,
        ...(options.assistantId ? { assistant_id: options.assistantId } : {}),
        ...(options.routeHint ? { route_hint: options.routeHint } : {}),
        ...(options.requestedCapability ? { requested_capability: options.requestedCapability } : {}),
        ...(options.claudeSkillSlug ? { claude_skill_slug: options.claudeSkillSlug } : {}),
        ...(options.historySummary ? { history_summary: options.historySummary } : {}),
        ...(options.memoryEnabled !== undefined ? { memory_enabled: options.memoryEnabled } : {}),
      });
      const runId = requireResponseData(runRes, 'Run creation').run_id;
      const result = await client.pollRun(runId);
      handleOutput(options.json ?? false, requireResponseData(result, 'Assist run').output, 'Assist Result');
    } catch (error: unknown) {
      exitWithError(`Error: ${formatError(error)}`);
    }
  });

program.parse(process.argv);
