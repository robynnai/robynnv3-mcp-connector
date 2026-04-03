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
import { registerConversationTools } from '../tools/conversations';
import { registerGeoTools } from '../tools/geo';
import { registerBattlecardTools } from '../tools/battlecard';
import { registerSeoTools } from '../tools/seo';
import { registerBrandBookTools } from '../tools/brand-book';
import { registerWebsiteTools } from '../tools/website';

const program = new Command();
const DEFAULT_API_URL = process.env.ROBYNN_API_BASE_URL || 'https://robynn.ai';

program
  .name('robynn')
  .description('Robynn AI Official CLI & Local MCP Bridge')
  .version('0.1.0');

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
      console.log(`❌ Not authenticated. Run 'robynn init <key>' first.`);
      process.exit(1);
    }
  });

// --- MCP Bridge ---
program
  .command('mcp')
  .description('Start the local Stdio MCP Server')
  .action(async () => {
    const config = readConfig();
    if (!config.apiKey) {
      console.error('❌ Not authenticated. Run `robynn init <key>` first.');
      process.exit(1);
    }

    const client = new RobynnClient(DEFAULT_API_URL, config.apiKey);
    const server = new McpServer({
      name: "Robynn (Local CLI)",
      version: "0.1.0",
    });

    // Register all tools just like the Cloudflare worker
    registerContextTools(server, client);
    registerStatusTools(server, client);
    registerContentTools(server, client);
    registerResearchTools(server, client);
    registerConversationTools(server, client);
    registerGeoTools(server, client);
    registerBattlecardTools(server, client);
    registerSeoTools(server, client);
    registerBrandBookTools(server, client);
    registerWebsiteTools(server, client);

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
  .option('--json', 'Output strictly as JSON')
  .action(async (options) => {
    const config = readConfig();
    if (!config.apiKey) { console.error('Not authenticated.'); process.exit(1); }
    const client = new RobynnClient(DEFAULT_API_URL, config.apiKey);
    try {
      if (!options.json) console.log('⏳ Running GEO analysis... (this may take 1-2 minutes)');
      const res = await client.geoAnalysis({ query: options.query });
      handleOutput(options.json, res, 'GEO Analysis Result');
    } catch (e: any) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });

analyze
  .command('seo')
  .description('Run an SEO opportunities analysis')
  .requiredOption('-u, --url <url>', 'Website URL')
  .option('--json', 'Output strictly as JSON')
  .action(async (options) => {
    const config = readConfig();
    if (!config.apiKey) { console.error('Not authenticated.'); process.exit(1); }
    const client = new RobynnClient(DEFAULT_API_URL, config.apiKey);
    try {
      if (!options.json) console.log('⏳ Running SEO analysis...');
      const res = await client.seoOpportunities({ url: options.url });
      handleOutput(options.json, res, 'SEO Opportunities Result');
    } catch (e: any) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });

const brand = program.command('brand').description('Brand context and status');

brand
  .command('context')
  .description('Get the current brand context')
  .option('--json', 'Output strictly as JSON')
  .action(async (options) => {
    const config = readConfig();
    if (!config.apiKey) { console.error('Not authenticated.'); process.exit(1); }
    const client = new RobynnClient(DEFAULT_API_URL, config.apiKey);
    try {
      const res = await client.getBrandContext('full');
      handleOutput(options.json, res, 'Brand Context');
    } catch (e: any) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });


const research = program.command('research').description('Research companies and topics');
research
  .command('company')
  .description('Research a company')
  .requiredOption('-q, --query <text>', 'Company name')
  .option('--json', 'Output strictly as JSON')
  .action(async (options) => {
    const config = readConfig();
    if (!config.apiKey) { console.error('Not authenticated.'); process.exit(1); }
    const client = new RobynnClient(DEFAULT_API_URL, config.apiKey);
    try {
      if (!options.json) console.log('⏳ Running research on ' + options.query + '...');
      const threadRes = await client.createThread(`Research: ${options.query}`);
      const threadId = threadRes.data.id;
      const runRes = await client.startRun(threadId, { message: `Research: ${options.query}`, type: "research" });
      const result = await client.pollRun(runRes.data.run_id);
      handleOutput(options.json, result.data.output, 'Research Result');
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });

const content = program.command('content').description('Generate content and draft emails');
content
  .command('email')
  .description('Draft an email')
  .requiredOption('-p, --prompt <text>', 'Email prompt')
  .option('--json', 'Output strictly as JSON')
  .action(async (options) => {
    const config = readConfig();
    if (!config.apiKey) { console.error('Not authenticated.'); process.exit(1); }
    const client = new RobynnClient(DEFAULT_API_URL, config.apiKey);
    try {
      if (!options.json) console.log('⏳ Drafting email...');
      const threadRes = await client.createThread(`Email Draft`);
      const threadId = threadRes.data.id;
      const runRes = await client.startRun(threadId, { message: options.prompt, type: "content" });
      const result = await client.pollRun(runRes.data.run_id);
      handleOutput(options.json, result.data.output, 'Draft Email');
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

