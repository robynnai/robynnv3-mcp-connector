import { describe, expect, it, vi } from "vitest";

import { installProvisionedOpenClaw } from "./install";

function createFsStub() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const chmodCalls: Array<{ path: string; mode: number }> = [];

  return {
    files,
    directories,
    chmodCalls,
    async mkdir(targetPath: string) {
      directories.add(targetPath);
    },
    async writeFile(targetPath: string, contents: string) {
      files.set(targetPath, contents);
    },
    async chmod(targetPath: string, mode: number) {
      chmodCalls.push({ path: targetPath, mode });
    },
  };
}

describe("installProvisionedOpenClaw", () => {
  it("writes config, workspace files, systemd unit, and posts an initial heartbeat", async () => {
    const fsStub = createFsStub();
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const client = {
      redeemOpenClawProvisionToken: vi.fn().mockResolvedValue({
        success: true,
        data: {
          install_id: "install-1",
          organization_id: "org-123",
          organization_name: "Acme",
          robynn_auth: {
            api_key: "rbo_test_key",
            base_url: "https://robynn.test",
          },
          profile: {
            slug: "robynn-cmo",
            version: "2026-04-14.1",
            agent_id: "robynn-cmo",
            workspace_directory: "workspace-robynn-cmo",
            gateway_service_name: "openclaw-gateway.service",
            gateway_port: 18789,
            mcp_servers: {
              robynn: {
                command: "robynn",
                args: ["mcp"],
              },
            },
            workspace_seed_files: [
              "AGENTS.md",
              "skills/robynn-cmo/SKILL.md",
            ],
          },
          runtime_token: "rclaw_rt_123",
        },
      }),
      heartbeatOpenClawInstall: vi.fn().mockResolvedValue({
        success: true,
        data: {
          install_id: "install-1",
          last_health_status: "healthy",
        },
      }),
    };

    const result = await installProvisionedOpenClaw({
      provisionToken: "rclaw_pt_123",
      homeDir: "/home/alice",
      hostname: "srv1369857",
      openclawVersion: "2026.4.5",
      robynnCliVersion: "0.1.9",
      client: client as never,
      fs: fsStub as never,
      runCommand,
    });

    expect(client.redeemOpenClawProvisionToken).toHaveBeenCalledWith({
      token: "rclaw_pt_123",
      hostname: "srv1369857",
      machine_label: undefined,
      openclaw_version: "2026.4.5",
      robynn_cli_version: "0.1.9",
    });

    expect(
      fsStub.files.get("/home/alice/.robynn/config.json"),
    ).toContain('"apiKey": "rbo_test_key"');
    expect(
      fsStub.files.get("/home/alice/.openclaw/openclaw.json"),
    ).toContain('"robynn"');
    expect(
      fsStub.files.get("/home/alice/.openclaw/workspace-robynn-cmo/AGENTS.md"),
    ).toContain("Robynn");
    expect(
      fsStub.files.get(
        "/home/alice/.openclaw/workspace-robynn-cmo/skills/robynn-cmo/SKILL.md",
      ),
    ).toContain("Robynn");
    expect(
      fsStub.files.get(
        "/home/alice/.config/systemd/user/openclaw-gateway.service",
      ),
    ).toContain("ExecStart=");

    expect(runCommand).toHaveBeenNthCalledWith(1, "systemctl", [
      "--user",
      "daemon-reload",
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, "systemctl", [
      "--user",
      "enable",
      "--now",
      "openclaw-gateway.service",
    ]);
    expect(client.heartbeatOpenClawInstall).toHaveBeenCalledWith(
      "install-1",
      expect.objectContaining({
        status: "healthy",
        openclaw_version: "2026.4.5",
        robynn_cli_version: "0.1.9",
      }),
      "rclaw_rt_123",
    );
    expect(result.installId).toBe("install-1");
  });
});
