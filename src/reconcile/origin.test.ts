import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  annotatePlan,
  configPath,
  driftOrigins,
  formatOrigin,
  formatOrigins,
  originAt,
  type FieldOrigin,
  type PolicyProvenance,
} from "./origin.js";
import { diff, renderChangeSet } from "./diff.js";
import { runReconcile } from "./runner.js";
import { repoSettingsCycle } from "../cycles/repo-settings.js";
import { branchProtectionCycle } from "../cycles/branch-protection.js";
import { makeClient } from "../cycles/_testutil.js";
import { loadGovernancePolicy } from "../config/load.js";
import type { GovernanceConfig } from "../config/types.js";

const at = (line: number, column: number) => ({ file: "policy.ts", line, column });

const PARAM: FieldOrigin = {
  kind: "composite-parameter",
  composite: "reviewPreset",
  parameters: ["squashOnly"],
  call: at(30, 14),
  arguments: { squashOnly: at(30, 55) },
};
const LITERAL: FieldOrigin = { kind: "composite-literal", composite: "reviewPreset", call: at(30, 14), literal: at(10, 21) };
const DIRECT: FieldOrigin = { kind: "direct" };
const UNKNOWN: FieldOrigin = { kind: "unknown", reason: "host-call" };

const config: GovernanceConfig = {
  orgs: {
    "my-org": {
      settings: { description: "Engineering" },
      repos: {
        api: {
          allowMergeCommits: false,
          allowSquashMerge: true,
          hasWiki: false,
          description: "api",
          topics: ["service", "api"],
          branchProtection: [{ ruleName: "release" }, { ruleName: "main", requiredApprovals: 2 }],
          webhooks: [{ url: "https://hooks.example/a/b", active: true }],
          variables: [{ name: "REGION", value: "eu" }],
        },
      },
    },
  },
};

const prov: PolicyProvenance = {
  paths: {
    'orgs["my-org"].settings.description': DIRECT,
    'orgs["my-org"].repos.api.allowMergeCommits': PARAM,
    'orgs["my-org"].repos.api.allowSquashMerge': LITERAL,
    'orgs["my-org"].repos.api.hasWiki': DIRECT,
    'orgs["my-org"].repos.api.description': UNKNOWN,
    'orgs["my-org"].repos.api.topics[0]': DIRECT,
    'orgs["my-org"].repos.api.topics[1]': UNKNOWN,
    'orgs["my-org"].repos.api.branchProtection[1].requiredApprovals': PARAM,
    'orgs["my-org"].repos.api.webhooks[0].active': LITERAL,
  },
};

describe("configPath", () => {
  it("maps each resource type's field to its path in the policy, joining list members on their key", () => {
    const p = (t: string, k: string, f: string) => configPath(config, "my-org", t, k, f);
    expect(p("org-settings", "org-settings", "description")).toBe('orgs["my-org"].settings.description');
    expect(p("repo", "api", "allowMergeCommits")).toBe('orgs["my-org"].repos.api.allowMergeCommits');
    expect(p("branch-protection", "api/main", "requiredApprovals")).toBe('orgs["my-org"].repos.api.branchProtection[1].requiredApprovals');
    expect(p("repo-webhook", "api/https://hooks.example/a/b", "active")).toBe('orgs["my-org"].repos.api.webhooks[0].active');
    expect(p("repo-variable", "api/REGION", "value")).toBe('orgs["my-org"].repos.api.variables[0].value');
    expect(p("team", "platform", "description")).toBe('orgs["my-org"].teams.platform.description');
    expect(p("branch-protection", "api/missing", "requiredApprovals")).toBeUndefined();
    expect(p("member", "alice", "username")).toBeUndefined();
    expect(configPath(config, "other-org", "repo", "api", "hasWiki")).toBeUndefined();
  });
});

describe("originAt", () => {
  it("an exact leaf, a list's distinct element origins, a path under a reported leaf, and nothing", () => {
    expect(originAt(prov, 'orgs["my-org"].repos.api.allowMergeCommits')).toEqual([PARAM]);
    expect(originAt(prov, 'orgs["my-org"].repos.api.topics')).toEqual([DIRECT, UNKNOWN]);
    expect(originAt(prov, 'orgs["my-org"].repos.api.hasWiki.deeper[0]')).toEqual([DIRECT]);
    expect(originAt(prov, 'orgs["my-org"].repos.api.website')).toEqual([]);
  });
});

describe("formatOrigin", () => {
  it("names the preset argument and its line, the preset body line, direct, and unknown with its reason", () => {
    expect(formatOrigin(PARAM)).toBe("reviewPreset(...) argument squashOnly at policy.ts:30:55");
    expect(formatOrigin(LITERAL)).toBe("reviewPreset(...) sets it in its body at policy.ts:10:21, called at policy.ts:30:14");
    expect(formatOrigin(DIRECT)).toBe("direct");
    expect(formatOrigin(UNKNOWN)).toBe("unknown (host-call)");
  });

  it("a parameter whose default applied has no argument to point at, so the call is named", () => {
    const o: FieldOrigin = { kind: "composite-parameter", composite: "reviewPreset", parameters: ["approvals"], call: at(30, 14) };
    expect(formatOrigin(o)).toBe("reviewPreset(...) parameter approvals (default applied), called at policy.ts:30:14");
  });

  it("nothing reported is unknown, never direct", () => {
    expect(formatOrigins([])).toBe("unknown (not reported)");
  });
});

describe("annotatePlan", () => {
  it("writes each drifted field's origin under its plan line, for all four kinds", () => {
    const cs = diff(
      "my-org",
      { repos: config.orgs["my-org"].repos },
      {
        repos: {
          api: {
            allowMergeCommits: true,
            allowSquashMerge: false,
            hasWiki: true,
            description: "drifted",
            topics: ["service", "api"],
            branchProtection: [{ ruleName: "release" }, { ruleName: "main", requiredApprovals: 1 }],
            webhooks: [{ url: "https://hooks.example/a/b", active: false }],
            variables: [{ name: "REGION", value: "eu" }],
          },
        },
      },
    );
    const drift = driftOrigins(cs, config, prov);
    expect(drift.map((d) => [d.resourceType, d.field, d.origins.map((o) => o.kind)])).toEqual([
      ["repo", "description", ["unknown"]],
      ["repo", "hasWiki", ["direct"]],
      ["repo", "allowMergeCommits", ["composite-parameter"]],
      ["repo", "allowSquashMerge", ["composite-literal"]],
      ["branch-protection", "requiredApprovals", ["composite-parameter"]],
      ["repo-webhook", "active", ["composite-literal"]],
    ]);
    const plan = annotatePlan(renderChangeSet(cs), drift);
    expect(plan).toContain(
      [
        "  [repo] api",
        "    description: drifted → api",
        "      <- unknown (host-call)",
        "    hasWiki: true → false",
        "      <- direct",
        "    allowMergeCommits: true → false",
        "      <- reviewPreset(...) argument squashOnly at policy.ts:30:55",
        "    allowSquashMerge: false → true",
        "      <- reviewPreset(...) sets it in its body at policy.ts:10:21, called at policy.ts:30:14",
      ].join("\n"),
    );
    expect(plan).toContain(
      ["  [branch-protection] api/main", "    requiredApprovals: 1 → 2", "      <- reviewPreset(...) argument squashOnly at policy.ts:30:55"].join("\n"),
    );
  });

  it("a plan with no drift is returned as it was", () => {
    expect(annotatePlan("Plan for x: 0 to create, 0 to update, 0 to delete\nNo changes.", [])).toBe(
      "Plan for x: 0 to create, 0 to update, 0 to delete\nNo changes.",
    );
  });
});

describe("the example policy's preset, folded", () => {
  const policy = "examples/governance.ts";
  const lineOf = (needle: string): number =>
    readFileSync(resolve(policy), "utf-8").split("\n").findIndex((l) => l.includes(needle)) + 1;

  it("a preset-set field resolves to the preset argument on the line the preset is applied", async () => {
    const { provenance } = await loadGovernancePolicy(policy, "fold");
    expect(provenance).toBeDefined();
    const line = lineOf("reviewPreset({ approvals: 2, squashOnly: true })");
    const [origin] = originAt(provenance!, 'orgs["my-org"].repos.api.allowMergeCommits');
    expect(origin).toMatchObject({
      kind: "composite-parameter",
      composite: "reviewPreset",
      parameters: ["squashOnly"],
      arguments: { squashOnly: { file: policy, line } },
    });
    const [approvals] = originAt(provenance!, 'orgs["my-org"].repos.api.branchProtection[0].requiredApprovals');
    expect(approvals).toMatchObject({ kind: "composite-parameter", arguments: { approvals: { file: policy, line } } });
    expect(originAt(provenance!, 'orgs["my-org"].repos.api.hasWiki')).toEqual([{ kind: "direct" }]);
  });

  it("run mode and YAML carry no provenance", async () => {
    expect((await loadGovernancePolicy(policy, "run")).provenance).toBeUndefined();
    expect((await loadGovernancePolicy("examples/governance.yml")).provenance).toBeUndefined();
  });

  it("a dry-run against drifted live state names the preset argument and the direct field in the plan", async () => {
    const { config: cfg, provenance } = await loadGovernancePolicy(policy, "fold");
    const client = makeClient({
      "GET /orgs/my-org/repos?limit=50&page=1": [
        // api: merge commits re-enabled out of band (preset-set), wiki turned on (direct).
        { name: "api", has_wiki: true, has_pull_requests: true, allow_squash_merge: true, allow_merge_commits: true, allow_rebase: false, topics: ["service", "api"] },
        { name: "web", has_wiki: false, has_pull_requests: true, allow_squash_merge: true, allow_merge_commits: true, allow_rebase: true, topics: ["service", "web"] },
      ],
      "GET /repos/my-org/api/branch_protections?limit=50&page=1": [
        { rule_name: "main", required_approvals: 1, enable_status_check: true, status_check_contexts: ["ci"], dismiss_stale_approvals: true },
      ],
      "GET /repos/my-org/web/branch_protections?limit=50&page=1": [
        { rule_name: "main", required_approvals: 1, enable_status_check: true, status_check_contexts: ["ci"], dismiss_stale_approvals: true },
      ],
    });
    const result = await runReconcile({ config: cfg, client, cycles: [repoSettingsCycle, branchProtectionCycle], mode: "dry-run", provenance });
    const line = lineOf("reviewPreset({ approvals: 2, squashOnly: true })");
    const [repos, bps] = result.cycles;
    expect(repos!.plan).toContain(
      ["  [repo] api", "    hasWiki: true → false", "      <- direct", "    allowMergeCommits: true → false", `      <- reviewPreset(...) argument squashOnly at ${policy}:${line}:55`].join("\n"),
    );
    expect(bps!.plan).toContain(
      ["  [branch-protection] api/main", "    requiredApprovals: 1 → 2", `      <- reviewPreset(...) argument approvals at ${policy}:${line}:40`].join("\n"),
    );
    expect(repos!.origins?.find((o) => o.field === "allowMergeCommits")?.origins[0]?.kind).toBe("composite-parameter");
    if (process.env.SHOW_PLAN) console.log(`${repos!.plan}\n\n${bps!.plan}`);
  });

  it("without provenance the plan is chant's, unannotated", async () => {
    const cfg: GovernanceConfig = { orgs: { o: { repos: { r: { hasWiki: false } } } } };
    const client = makeClient({ "GET /orgs/o/repos?limit=50&page=1": [{ name: "r", has_wiki: true }] });
    const result = await runReconcile({ config: cfg, client, cycles: [repoSettingsCycle], mode: "dry-run" });
    expect(result.cycles[0]!.plan).not.toContain("<-");
    expect(result.cycles[0]!.origins).toBeUndefined();
  });
});
