import type { OpenClawManifest } from "../types";

import { ROBYNN_CMO_PROFILE_SEED_FILES } from "./profile-seeds";

export function buildOpenClawConfig(manifest: OpenClawManifest) {
  return {
    mcp: {
      servers: manifest.mcp_servers,
    },
  };
}

export function buildGatewaySystemdUnit(port: number, workspacePath: string) {
  return `[Unit]
Description=OpenClaw Gateway
After=default.target

[Service]
Type=simple
WorkingDirectory=${workspacePath}
ExecStart=/usr/bin/env openclaw gateway start --port ${port}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function buildWorkspaceSeedFiles() {
  return { ...ROBYNN_CMO_PROFILE_SEED_FILES };
}
