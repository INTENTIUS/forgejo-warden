import { describe, it, expect } from "vitest";
import { parseReconcileArgs, CliError } from "../cli.js";

describe("parseReconcileArgs", () => {
  it("parses a valid invocation", () => {
    const a = parseReconcileArgs([
      "--config", "gov.yml",
      "--base-url", "https://forge.example.com",
      "--token-env", "FORGEJO_TOKEN",
      "--mode", "apply",
      "--cycles", "org-settings,teams",
    ]);
    expect(a.config).toBe("gov.yml");
    expect(a.baseUrl).toBe("https://forge.example.com");
    expect(a.tokenEnv).toBe("FORGEJO_TOKEN");
    expect(a.mode).toBe("apply");
    expect(a.cycles).toEqual(["org-settings", "teams"]);
    expect(a.allowGuardrailOverride).toBe(false);
  });

  it("accepts --base-url-env in place of --base-url", () => {
    const a = parseReconcileArgs(["--config", "g.yml", "--base-url-env", "FORGE_URL", "--token-env", "T"]);
    expect(a.baseUrlEnv).toBe("FORGE_URL");
    expect(a.baseUrl).toBeUndefined();
  });

  it("defaults mode to dry-run and parses the override flag", () => {
    const a = parseReconcileArgs(["--config", "g.yml", "--base-url", "u", "--token-env", "T", "--allow-guardrail-override"]);
    expect(a.mode).toBe("dry-run");
    expect(a.allowGuardrailOverride).toBe(true);
  });

  it("parses --removal-cap-fraction and leaves it undefined by default", () => {
    const base = ["--config", "g.yml", "--base-url", "u", "--token-env", "T"];
    expect(parseReconcileArgs(base).removalCapFraction).toBeUndefined();
    expect(parseReconcileArgs([...base, "--removal-cap-fraction", "0.5"]).removalCapFraction).toBe(0.5);
    expect(parseReconcileArgs([...base, "--removal-cap-fraction", "1"]).removalCapFraction).toBe(1);
  });

  it("throws code 2 on a --removal-cap-fraction outside (0,1]", () => {
    const base = ["--config", "g.yml", "--base-url", "u", "--token-env", "T"];
    const bad = (v: string) =>
      expect(() => parseReconcileArgs([...base, "--removal-cap-fraction", v])).toThrow(
        expect.objectContaining({ code: 2 }),
      );
    bad("0");
    bad("-0.5");
    bad("1.5");
    bad("nope");
    expect(() => parseReconcileArgs([...base, "--removal-cap-fraction"])).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("parses --plan-json and --member, refusing --plan-json with --mode apply and --member without --plan-json", () => {
    const base = ["--config", "g.yml", "--base-url", "u", "--token-env", "T"];
    const a = parseReconcileArgs(base);
    expect(a.planJson).toBeUndefined();
    expect(a.member).toBeUndefined();
    const b = parseReconcileArgs([...base, "--plan-json", "plan.json", "--member", "gov"]);
    expect(b.planJson).toBe("plan.json");
    expect(b.member).toBe("gov");
    const bad = (argv: string[]) => expect(() => parseReconcileArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad([...base, "--plan-json"]);
    bad([...base, "--plan-json", "plan.json", "--member"]);
    bad([...base, "--mode", "apply", "--plan-json", "plan.json"]);
    bad([...base, "--member", "gov"]);
    bad([...base, "--plan-json", "plan.json", "--member", ""]);
  });

  it("parses --drift-issue and --drift-issue-repo, refusing them with --mode apply or alone", () => {
    const base = ["--config", "g.yml", "--base-url", "u", "--token-env", "T"];
    const a = parseReconcileArgs(base);
    expect(a.driftIssue).toBe(false);
    expect(a.driftIssueRepo).toBeUndefined();
    const b = parseReconcileArgs([...base, "--drift-issue", "--drift-issue-repo", "acme/governance", "--member", "gov"]);
    expect(b.driftIssue).toBe(true);
    expect(b.driftIssueRepo).toBe("acme/governance");
    expect(b.member).toBe("gov");
    expect(b.planJson).toBeUndefined();
    const bad = (argv: string[]) => expect(() => parseReconcileArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad([...base, "--mode", "apply", "--drift-issue"]);
    bad([...base, "--drift-issue-repo", "acme/governance"]);
    bad([...base, "--drift-issue", "--drift-issue-repo"]);
    bad([...base, "--drift-issue", "--drift-issue-repo", "governance"]);
    bad([...base, "--drift-issue", "--drift-issue-repo", "acme/gov/extra"]);
    bad([...base, "--drift-issue", "--cycles", "teams"]);
  });

  it("leaves config undefined when --config is omitted", () => {
    expect(parseReconcileArgs(["--base-url", "u", "--token-env", "T"]).config).toBeUndefined();
  });

  it("throws code 2 on missing instance url / token / bad mode / unknown flag", () => {
    const bad = (argv: string[]) => expect(() => parseReconcileArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad(["--config", "g.yml", "--token-env", "T"]); // no base url
    bad(["--config", "g.yml", "--base-url", "u"]); // no token
    bad(["--config", "g.yml", "--base-url", "u", "--token-env", "T", "--mode", "nope"]);
    bad(["--config", "g.yml", "--base-url", "u", "--token-env", "T", "--bogus"]);
    expect(() => parseReconcileArgs(["--config", "u", "--token-env"])).toThrow(CliError);
  });
});
