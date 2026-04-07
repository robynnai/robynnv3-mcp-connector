import packageJson from "../package.json";

export const APP_VERSION = packageJson.version;

export function getServerVersion(version?: string): string {
  return version || APP_VERSION;
}
