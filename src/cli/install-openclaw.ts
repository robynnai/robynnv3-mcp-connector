import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OPENCLAW_SERVER_NAME = 'robynn';

export interface OpenClawServerDefinition {
  command: string;
  args: string[];
}

export interface OpenClawPathOptions {
  user?: string;
  homeDir?: string;
}

export interface InstallOpenClawOptions extends OpenClawPathOptions {
  apiKeyConfigured?: boolean;
  fsModule?: OpenClawFs;
}

export interface InstallOpenClawResult {
  status: 'installed' | 'updated' | 'already-configured' | 'manual-required';
  checkedPaths: string[];
  configPath?: string;
  instructions?: string;
  error?: string;
  nextStep?: string;
}

export interface OpenClawFs {
  existsSync(targetPath: string): boolean;
  readFileSync(targetPath: string, encoding: BufferEncoding): string;
  writeFileSync(targetPath: string, contents: string, encoding: BufferEncoding): void;
  renameSync(fromPath: string, toPath: string): void;
}

const NODE_FS: OpenClawFs = {
  existsSync(targetPath) {
    return fs.existsSync(targetPath);
  },
  readFileSync(targetPath, encoding) {
    return fs.readFileSync(targetPath, encoding);
  },
  writeFileSync(targetPath, contents, encoding) {
    fs.writeFileSync(targetPath, contents, encoding);
  },
  renameSync(fromPath, toPath) {
    fs.renameSync(fromPath, toPath);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildOpenClawServerDefinition(): OpenClawServerDefinition {
  return {
    command: 'robynn',
    args: ['mcp'],
  };
}

export function buildOpenClawConfigPaths(
  options: OpenClawPathOptions = {},
): string[] {
  const user = options.user || process.env.USER || process.env.LOGNAME || '';
  const homeDir = options.homeDir || os.homedir();
  const candidates = [
    user ? path.join('/home', user, '.openclaw', 'openclaw.json') : '',
    path.join(homeDir, '.openclaw', 'openclaw.json'),
  ].filter(Boolean);

  return [...new Set(candidates)];
}

export function patchOpenClawConfig(config: unknown): Record<string, unknown> {
  const root = isRecord(config) ? { ...config } : {};
  const mcp = isRecord(root.mcp) ? { ...root.mcp } : {};
  const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {};

  servers[OPENCLAW_SERVER_NAME] = buildOpenClawServerDefinition();
  mcp.servers = servers;
  root.mcp = mcp;

  return root;
}

function instructionsForManualInstall(
  checkedPaths: string[],
  options: { apiKeyConfigured?: boolean; error?: string } = {},
): string {
  const checked = checkedPaths.map((checkedPath) => `- ${checkedPath}`).join('\n');
  const snippet = JSON.stringify(
    {
      mcp: {
        servers: {
          [OPENCLAW_SERVER_NAME]: buildOpenClawServerDefinition(),
        },
      },
    },
    null,
    2,
  );

  const lines = [
    options.error ? `OpenClaw auto-install failed: ${options.error}` : 'OpenClaw config not found.',
    'Checked:',
    checked,
    '',
    'Add this to your OpenClaw config:',
    snippet,
    '',
  ];

  if (!options.apiKeyConfigured) {
    lines.push('Then run:', 'robynn init rbo_...');
  } else {
    lines.push('Your Robynn API key is already configured.');
  }

  return lines.join('\n');
}

function readJsonConfig(
  fsModule: Pick<OpenClawFs, 'readFileSync'>,
  configPath: string,
): unknown {
  return JSON.parse(fsModule.readFileSync(configPath, 'utf-8'));
}

function writeJsonAtomic(
  fsModule: Pick<OpenClawFs, 'writeFileSync' | 'renameSync'>,
  configPath: string,
  config: Record<string, unknown>,
): void {
  const tempPath = `${configPath}.${process.pid}.tmp`;
  fsModule.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  fsModule.renameSync(tempPath, configPath);
}

export function installOpenClaw(
  options: InstallOpenClawOptions = {},
): InstallOpenClawResult {
  const fsModule = options.fsModule || NODE_FS;
  const checkedPaths = buildOpenClawConfigPaths(options);
  const configPath = checkedPaths.find((candidate) => fsModule.existsSync(candidate));

  if (!configPath) {
    return {
      status: 'manual-required',
      checkedPaths,
      instructions: instructionsForManualInstall(checkedPaths, {
        apiKeyConfigured: options.apiKeyConfigured,
      }),
      nextStep: options.apiKeyConfigured ? undefined : 'robynn init rbo_...',
    };
  }

  let parsed: unknown;
  try {
    parsed = readJsonConfig(fsModule, configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    return {
      status: 'manual-required',
      checkedPaths,
      configPath,
      error: message,
      instructions: instructionsForManualInstall(checkedPaths, {
        apiKeyConfigured: options.apiKeyConfigured,
        error: message,
      }),
      nextStep: options.apiKeyConfigured ? undefined : 'robynn init rbo_...',
    };
  }

  const existingServer = isRecord(parsed)
    && isRecord(parsed.mcp)
    && isRecord(parsed.mcp.servers)
    ? parsed.mcp.servers[OPENCLAW_SERVER_NAME]
    : undefined;
  const desiredServer = buildOpenClawServerDefinition();

  if (JSON.stringify(existingServer) === JSON.stringify(desiredServer)) {
    return {
      status: 'already-configured',
      checkedPaths,
      configPath,
      nextStep: options.apiKeyConfigured ? undefined : 'robynn init rbo_...',
    };
  }

  const patched = patchOpenClawConfig(parsed);
  try {
    writeJsonAtomic(fsModule, configPath, patched);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write OpenClaw config';
    return {
      status: 'manual-required',
      checkedPaths,
      configPath,
      error: message,
      instructions: instructionsForManualInstall(checkedPaths, {
        apiKeyConfigured: options.apiKeyConfigured,
        error: message,
      }),
      nextStep: options.apiKeyConfigured ? undefined : 'robynn init rbo_...',
    };
  }

  return {
    status: existingServer === undefined ? 'installed' : 'updated',
    checkedPaths,
    configPath,
    nextStep: options.apiKeyConfigured ? undefined : 'robynn init rbo_...',
  };
}
