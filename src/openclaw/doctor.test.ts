import { describe, expect, it, vi } from "vitest";

import { runOpenClawDoctor } from "./doctor";

function createDoctorDeps(overrides?: {
  commandExists?: (command: string) => Promise<boolean>;
  fileExists?: (path: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
  runCommand?: (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}) {
  return {
    homeDir: "/home/alice",
    commandExists:
      overrides?.commandExists ||
      vi.fn().mockImplementation(async (command: string) =>
        ["openclaw", "robynn"].includes(command),
      ),
    fileExists:
      overrides?.fileExists ||
      vi
        .fn()
        .mockImplementation(async (path: string) =>
          [
            "/home/alice/.robynn/config.json",
            "/home/alice/.openclaw/openclaw.json",
          ].includes(path),
        ),
    readFile:
      overrides?.readFile ||
      vi.fn().mockResolvedValue(
        JSON.stringify({
          mcp: {
            servers: {
              robynn: {
                command: "robynn",
                args: ["mcp"],
              },
            },
          },
        }),
      ),
    runCommand:
      overrides?.runCommand ||
      vi.fn().mockImplementation(async (command: string, args: string[]) => {
        if (command === "robynn" && args[0] === "mcp") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "systemctl") {
          return { stdout: "active\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
  };
}

describe("runOpenClawDoctor", () => {
  it("fails when the robynn binary is missing", async () => {
    const result = await runOpenClawDoctor(
      createDoctorDeps({
        commandExists: vi
          .fn()
          .mockImplementation(async (command: string) => command === "openclaw"),
      }) as never,
    );

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "robynn binary")?.ok).toBe(
      false,
    );
  });

  it("fails when the OpenClaw config is missing", async () => {
    const result = await runOpenClawDoctor(
      createDoctorDeps({
        fileExists: vi
          .fn()
          .mockImplementation(async (path: string) =>
            path === "/home/alice/.robynn/config.json",
          ),
      }) as never,
    );

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.name === "openclaw config")?.ok,
    ).toBe(false);
  });

  it("fails when the Robynn config is missing", async () => {
    const result = await runOpenClawDoctor(
      createDoctorDeps({
        fileExists: vi
          .fn()
          .mockImplementation(async (path: string) =>
            path === "/home/alice/.openclaw/openclaw.json",
          ),
      }) as never,
    );

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "robynn config")?.ok).toBe(
      false,
    );
  });

  it("fails when robynn mcp does not start cleanly", async () => {
    const result = await runOpenClawDoctor(
      createDoctorDeps({
        runCommand: vi.fn().mockImplementation(async (command: string) => {
          if (command === "robynn") {
            return { stdout: "", stderr: "boom", exitCode: 1 };
          }
          return { stdout: "active\n", stderr: "", exitCode: 0 };
        }),
      }) as never,
    );

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.name === "robynn mcp health")?.ok,
    ).toBe(false);
  });

  it("returns success for a healthy install", async () => {
    const result = await runOpenClawDoctor(createDoctorDeps() as never);

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });
});
