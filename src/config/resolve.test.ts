import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigPath } from "./resolve.js";

const dirs: string[] = [];
const tmp = (files: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "fw-resolve-"));
  dirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveConfigPath", () => {
  it("returns an explicit --config as given", () => {
    expect(resolveConfigPath("other.yml", tmp(["governance.yml"]))).toBe("other.yml");
  });
  it("defaults to governance.yml in the working directory", () => {
    const dir = tmp(["governance.yml"]);
    expect(resolveConfigPath(undefined, dir)).toBe(join(dir, "governance.yml"));
  });
  it("prefers governance.yml over governance.ts", () => {
    const dir = tmp(["governance.yml", "governance.ts"]);
    expect(resolveConfigPath(undefined, dir)).toBe(join(dir, "governance.yml"));
  });
  it("uses governance.ts when governance.yml is absent", () => {
    const dir = tmp(["governance.ts"]);
    expect(resolveConfigPath(undefined, dir)).toBe(join(dir, "governance.ts"));
  });
  it("is undefined when neither file exists", () => {
    expect(resolveConfigPath(undefined, tmp([]))).toBeUndefined();
  });
});
