import { describe, expect, it } from 'vitest';

import {
  OPENCLAW_SERVER_NAME,
  buildOpenClawConfigPaths,
  buildOpenClawServerDefinition,
  installOpenClaw,
  patchOpenClawConfig,
} from './install-openclaw';

describe('buildOpenClawConfigPaths', () => {
  it('prefers /home/$USER before ~/.openclaw and removes duplicates', () => {
    const paths = buildOpenClawConfigPaths({
      user: 'alice',
      homeDir: '/home/alice',
    });

    expect(paths).toEqual(['/home/alice/.openclaw/openclaw.json']);
  });

  it('falls back to both candidate paths when they differ', () => {
    const paths = buildOpenClawConfigPaths({
      user: 'alice',
      homeDir: '/root',
    });

    expect(paths).toEqual([
      '/home/alice/.openclaw/openclaw.json',
      '/root/.openclaw/openclaw.json',
    ]);
  });
});

describe('buildOpenClawServerDefinition', () => {
  it('returns the local stdio robynn bridge entry', () => {
    expect(buildOpenClawServerDefinition()).toEqual({
      command: 'robynn',
      args: ['mcp'],
    });
  });
});

describe('patchOpenClawConfig', () => {
  it('adds the robynn server under mcp.servers while preserving unrelated fields', () => {
    const patched = patchOpenClawConfig({
      gateway: { port: 4040 },
      mcp: {
        servers: {
          docs: {
            url: 'https://example.com/mcp',
          },
        },
      },
    });

    expect(patched).toEqual({
      gateway: { port: 4040 },
      mcp: {
        servers: {
          docs: {
            url: 'https://example.com/mcp',
          },
          [OPENCLAW_SERVER_NAME]: {
            command: 'robynn',
            args: ['mcp'],
          },
        },
      },
    });
  });

  it('creates mcp.servers when missing', () => {
    const patched = patchOpenClawConfig({});

    expect(patched).toEqual({
      mcp: {
        servers: {
          [OPENCLAW_SERVER_NAME]: {
            command: 'robynn',
            args: ['mcp'],
          },
        },
      },
    });
  });

  it('overwrites an existing robynn server definition', () => {
    const patched = patchOpenClawConfig({
      mcp: {
        servers: {
          [OPENCLAW_SERVER_NAME]: {
            url: 'https://mcp.robynn.ai',
          },
        },
      },
    });

    expect(patched).toEqual({
      mcp: {
        servers: {
          [OPENCLAW_SERVER_NAME]: {
            command: 'robynn',
            args: ['mcp'],
          },
        },
      },
    });
  });
});

describe('installOpenClaw', () => {
  function createFsStub(files: Record<string, string> = {}) {
    const state = new Map(Object.entries(files));

    return {
      state,
      existsSync(targetPath: string) {
        return state.has(targetPath);
      },
      readFileSync(targetPath: string) {
        const value = state.get(targetPath);
        if (value === undefined) {
          throw new Error(`ENOENT: ${targetPath}`);
        }
        return value;
      },
      writeFileSync(targetPath: string, contents: string) {
        state.set(targetPath, contents);
      },
      renameSync(fromPath: string, toPath: string) {
        const value = state.get(fromPath);
        if (value === undefined) {
          throw new Error(`ENOENT: ${fromPath}`);
        }
        state.delete(fromPath);
        state.set(toPath, value);
      },
    };
  }

  it('falls back to manual instructions when no config exists', () => {
    const fsStub = createFsStub();
    const result = installOpenClaw({
      fsModule: fsStub,
      user: 'alice',
      homeDir: '/root',
      apiKeyConfigured: false,
    });

    expect(result.status).toBe('manual-required');
    expect(result.instructions).toContain('/home/alice/.openclaw/openclaw.json');
    expect(result.instructions).toContain('robynn init rbo_...');
  });

  it('patches the first existing config file with the robynn server entry', () => {
    const configPath = '/home/alice/.openclaw/openclaw.json';
    const fsStub = createFsStub({
      [configPath]: JSON.stringify({ gateway: { port: 4040 } }),
    });

    const result = installOpenClaw({
      fsModule: fsStub,
      user: 'alice',
      homeDir: '/root',
      apiKeyConfigured: false,
    });

    expect(result.status).toBe('installed');
    expect(result.configPath).toBe(configPath);
    expect(result.nextStep).toBe('robynn init rbo_...');

    const written = fsStub.state.get(configPath);
    expect(written).toBeDefined();
    expect(JSON.parse(written || '{}')).toEqual({
      gateway: { port: 4040 },
      mcp: {
        servers: {
          [OPENCLAW_SERVER_NAME]: {
            command: 'robynn',
            args: ['mcp'],
          },
        },
      },
    });
  });

  it('reports already-configured when the saved entry already matches', () => {
    const configPath = '/home/alice/.openclaw/openclaw.json';
    const fsStub = createFsStub({
      [configPath]: JSON.stringify({
        mcp: {
          servers: {
            [OPENCLAW_SERVER_NAME]: {
              command: 'robynn',
              args: ['mcp'],
            },
          },
        },
      }),
    });

    const result = installOpenClaw({
      fsModule: fsStub,
      user: 'alice',
      homeDir: '/root',
      apiKeyConfigured: true,
    });

    expect(result.status).toBe('already-configured');
    expect(result.nextStep).toBeUndefined();
  });
});
