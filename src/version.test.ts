import { describe, expect, it } from "vitest";

import packageJson from "../package.json";
import { APP_VERSION, getServerVersion } from "./version";

describe("version helpers", () => {
  it("uses the package version as the shared app version", () => {
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it("prefers explicit server version overrides and falls back to package version", () => {
    expect(getServerVersion("9.9.9")).toBe("9.9.9");
    expect(getServerVersion(undefined)).toBe(packageJson.version);
    expect(getServerVersion("")).toBe(packageJson.version);
  });
});
