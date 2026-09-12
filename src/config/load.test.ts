import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadGovernanceConfig, GovernanceConfigError } from "./load.js";

const ex = (name: string) => resolve(import.meta.dirname, "..", "..", "examples", name);

describe("loadGovernanceConfig", () => {
  it("a .ts policy folded, a .ts policy run, and the .yml load to the same object", async () => {
    const yml = await loadGovernanceConfig(ex("governance.yml"));
    const folded = await loadGovernanceConfig(ex("governance.ts"), "fold");
    const ran = await loadGovernanceConfig(ex("governance.ts"), "run");
    expect(folded).toEqual(yml);
    expect(ran).toEqual(yml);
    expect(folded.orgs["my-org"].repos?.api.branchProtection?.[0].ruleName).toBe("main");
  });

  it("check mode passes when folding and running agree", async () => {
    await expect(loadGovernanceConfig(ex("governance.ts"), "check")).resolves.toBeTruthy();
  });

  it("a policy that reads the environment is refused by fold, with the line, and accepted by run", async () => {
    await expect(loadGovernanceConfig(ex("not-data.ts"))).rejects.toThrow(GovernanceConfigError);
    await expect(loadGovernanceConfig(ex("not-data.ts"))).rejects.toThrow(/not data/);
    await expect(loadGovernanceConfig(ex("not-data.ts"))).rejects.toThrow(/\d+:\d+/);
    const ran = await loadGovernanceConfig(ex("not-data.ts"), "run");
    expect(ran.orgs["my-org"].repos?.api.hasWiki).toBe(false);
  });

  it("an undefined property is absent, the way JSON leaves it, so selective-by-omission holds", async () => {
    const dir = resolve(import.meta.dirname, "..", "..", "examples");
    const { writeFileSync, rmSync } = await import("node:fs");
    const p = resolve(dir, "tmp-undefined.ts");
    writeFileSync(p, 'const on = false;\nexport default { orgs: { o: { repos: { r: { hasWiki: on ? true : undefined } } } } };\n');
    try {
      const folded = await loadGovernanceConfig(p, "fold");
      expect("hasWiki" in (folded.orgs.o.repos?.r ?? {})).toBe(false);
    } finally {
      rmSync(p);
    }
  });

  it("refuses a config with no orgs map", async () => {
    await expect(loadGovernanceConfig(ex("governance.yml").replace("governance.yml", "../package.json"))).rejects.toThrow(/orgs/);
  });
});
