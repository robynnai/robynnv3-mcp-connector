import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type DoctorDependencies = {
  homeDir?: string;
  commandExists?: (command: string) => Promise<boolean>;
  fileExists?: (targetPath: string) => Promise<boolean>;
  readFile?: (targetPath: string) => Promise<string>;
  probeRobynnMcp?: () => Promise<RunCommandResult>;
  runCommand?: (
    command: string,
    args: string[],
  ) => Promise<RunCommandResult>;
};

export interface OpenClawDoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface OpenClawDoctorResult {
  ok: boolean;
  checks: OpenClawDoctorCheck[];
}

async function defaultCommandExists(command: string) {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function defaultFileExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function defaultReadFile(targetPath: string) {
  return fs.readFile(targetPath, "utf8");
}

async function defaultRunCommand(
  command: string,
  args: string[],
): Promise<RunCommandResult> {
  try {
    const result = await execFileAsync(command, args);
    return { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout || "",
      stderr: execError.stderr || "",
      exitCode: execError.code || 1,
    };
  }
}

function defaultProbeRobynnMcp(): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("robynn", ["mcp"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RunCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ stdout, stderr, exitCode: 0 });
    }, 250);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ stdout, stderr: error.message || stderr, exitCode: 1 });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export async function runOpenClawDoctor(
  dependencies: DoctorDependencies = {},
): Promise<OpenClawDoctorResult> {
  const homeDir = dependencies.homeDir || os.homedir();
  const commandExists = dependencies.commandExists || defaultCommandExists;
  const fileExists = dependencies.fileExists || defaultFileExists;
  const readFile = dependencies.readFile || defaultReadFile;
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const probeRobynnMcp =
    dependencies.probeRobynnMcp ||
    (dependencies.runCommand
      ? async () => dependencies.runCommand!("robynn", ["mcp"])
      : defaultProbeRobynnMcp);

  const checks: OpenClawDoctorCheck[] = [];

  const openclawBinary = await commandExists("openclaw");
  checks.push({ name: "openclaw binary", ok: openclawBinary });

  const robynnBinary = await commandExists("robynn");
  checks.push({ name: "robynn binary", ok: robynnBinary });

  const robynnConfigPath = path.join(homeDir, ".robynn", "config.json");
  const robynnConfig = await fileExists(robynnConfigPath);
  checks.push({ name: "robynn config", ok: robynnConfig });

  const openclawConfigPath = path.join(homeDir, ".openclaw", "openclaw.json");
  let openclawConfigValid = false;
  if (await fileExists(openclawConfigPath)) {
    try {
      const parsed = JSON.parse(await readFile(openclawConfigPath));
      openclawConfigValid =
        parsed?.mcp?.servers?.robynn?.command === "robynn" &&
        JSON.stringify(parsed?.mcp?.servers?.robynn?.args) ===
          JSON.stringify(["mcp"]);
    } catch {
      openclawConfigValid = false;
    }
  }
  checks.push({ name: "openclaw config", ok: openclawConfigValid });

  const mcpProbe = await probeRobynnMcp();
  checks.push({
    name: "robynn mcp health",
    ok: mcpProbe.exitCode === 0,
    detail: mcpProbe.stderr || undefined,
  });

  const systemdStatus = await runCommand("systemctl", [
    "--user",
    "is-active",
    "openclaw-gateway.service",
  ]);
  checks.push({
    name: "gateway service",
    ok: systemdStatus.exitCode === 0 && systemdStatus.stdout.trim() === "active",
    detail: systemdStatus.stdout.trim() || systemdStatus.stderr || undefined,
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
