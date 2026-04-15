import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RobynnClient } from "../robynn-client";
import type {
  OpenClawInstallHeartbeatRequest,
  OpenClawProvisionRedeemResult,
} from "../types";
import { APP_VERSION } from "../version";

import {
  buildGatewaySystemdUnit,
  buildOpenClawConfig,
  buildWorkspaceSeedFiles,
} from "./templates";

const execFileAsync = promisify(execFile);

interface FileSystemLike {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(
    path: string,
    contents: string,
    options?: { encoding?: BufferEncoding },
  ): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
}

type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RunCommand = (
  command: string,
  args: string[],
) => Promise<RunCommandResult>;

interface InstallerClientLike {
  redeemOpenClawProvisionToken(payload: {
    token: string;
    hostname: string;
    machine_label?: string;
    openclaw_version?: string;
    robynn_cli_version?: string;
  }): Promise<{ success: boolean; data?: OpenClawProvisionRedeemResult; error?: string }>;
  heartbeatOpenClawInstall(
    installId: string,
    payload: OpenClawInstallHeartbeatRequest,
    runtimeToken: string,
  ): Promise<{ success: boolean; data?: { install_id: string }; error?: string }>;
}

export interface InstallProvisionedOpenClawOptions {
  provisionToken: string;
  homeDir?: string;
  hostname?: string;
  machineLabel?: string;
  openclawVersion?: string;
  robynnCliVersion?: string;
  baseUrl?: string;
  client?: InstallerClientLike;
  fs?: FileSystemLike;
  runCommand?: RunCommand;
}

export interface InstallProvisionedOpenClawResult {
  installId: string;
  configPath: string;
  workspacePath: string;
  systemdUnitPath: string;
}

function defaultRunCommand(command: string, args: string[]): Promise<RunCommandResult> {
  return execFileAsync(command, args).then((result) => ({
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: 0,
  }));
}

const DEFAULT_FS: FileSystemLike = {
  mkdir(targetPath, options) {
    return fs.mkdir(targetPath, options);
  },
  writeFile(targetPath, contents, options) {
    return fs.writeFile(targetPath, contents, options?.encoding || "utf8");
  },
  chmod(targetPath, mode) {
    return fs.chmod(targetPath, mode);
  },
};

async function writeTextFile(
  fsImpl: FileSystemLike,
  targetPath: string,
  contents: string,
  mode?: number,
) {
  await fsImpl.mkdir(path.dirname(targetPath), { recursive: true });
  await fsImpl.writeFile(targetPath, contents, { encoding: "utf8" });
  if (mode !== undefined) {
    await fsImpl.chmod(targetPath, mode);
  }
}

export async function installProvisionedOpenClaw(
  options: InstallProvisionedOpenClawOptions,
): Promise<InstallProvisionedOpenClawResult> {
  const homeDir = options.homeDir || os.homedir();
  const hostname = options.hostname || os.hostname();
  const fsImpl = options.fs || DEFAULT_FS;
  const runCommand = options.runCommand || defaultRunCommand;
  const client =
    options.client ||
    new RobynnClient(options.baseUrl || "https://robynn.ai", "");

  const redeemed = await client.redeemOpenClawProvisionToken({
    token: options.provisionToken,
    hostname,
    machine_label: options.machineLabel,
    openclaw_version: options.openclawVersion || "unknown",
    robynn_cli_version: options.robynnCliVersion || APP_VERSION,
  });

  if (!redeemed.success || !redeemed.data) {
    throw new Error(redeemed.error || "OpenClaw provision redeem failed");
  }

  const robynnConfigPath = path.join(homeDir, ".robynn", "config.json");
  const openclawConfigPath = path.join(homeDir, ".openclaw", "openclaw.json");
  const workspacePath = path.join(
    homeDir,
    ".openclaw",
    redeemed.data.profile.workspace_directory || "workspace-robynn-cmo",
  );
  const systemdUnitPath = path.join(
    homeDir,
    ".config",
    "systemd",
    "user",
    redeemed.data.profile.gateway_service_name || "openclaw-gateway.service",
  );

  await writeTextFile(
    fsImpl,
    robynnConfigPath,
    `${JSON.stringify(
      {
        apiKey: redeemed.data.robynn_auth.api_key,
        baseUrl: redeemed.data.robynn_auth.base_url,
      },
      null,
      2,
    )}\n`,
    0o600,
  );

  await writeTextFile(
    fsImpl,
    openclawConfigPath,
    `${JSON.stringify(buildOpenClawConfig(redeemed.data.profile), null, 2)}\n`,
    0o644,
  );

  const workspaceSeedFiles = buildWorkspaceSeedFiles();
  for (const [relativePath, contents] of Object.entries(workspaceSeedFiles)) {
    await writeTextFile(
      fsImpl,
      path.join(workspacePath, relativePath),
      `${contents.trimEnd()}\n`,
      0o644,
    );
  }

  await writeTextFile(
    fsImpl,
    systemdUnitPath,
    buildGatewaySystemdUnit(
      redeemed.data.profile.gateway_port || 18789,
      workspacePath,
    ),
    0o644,
  );

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", [
    "--user",
    "enable",
    "--now",
    redeemed.data.profile.gateway_service_name || "openclaw-gateway.service",
  ]);

  const heartbeat = await client.heartbeatOpenClawInstall(
    redeemed.data.install_id,
    {
      status: "healthy",
      openclaw_version: options.openclawVersion || "unknown",
      robynn_cli_version: options.robynnCliVersion || APP_VERSION,
      gateway_running: true,
      robynn_mcp_healthy: true,
    },
    redeemed.data.runtime_token,
  );

  if (!heartbeat.success) {
    throw new Error(heartbeat.error || "Initial OpenClaw heartbeat failed");
  }

  return {
    installId: redeemed.data.install_id,
    configPath: openclawConfigPath,
    workspacePath,
    systemdUnitPath,
  };
}
