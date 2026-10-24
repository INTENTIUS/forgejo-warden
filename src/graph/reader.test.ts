import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { readGovernance } from "./reader.js";
import read from "./entry.js";

const POLICY = `
orgs:
  acme:
    settings: { visibility: limited }
    teams:
      backend:
        permission: write
        repos: [{ name: api }, { name: ghost }]
      everyone:
        permission: read
        includesAllRepositories: true
    repos:
      api:
        topics: [service]
        branchProtection:
          - { ruleName: main, requiredApprovals: 2 }
      web: {}
`;

const edge = (g: ReturnType<typeof readGovernance>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe("readGovernance", () => {
  const g = readGovernance(parse(POLICY), "governance.yml");

  test("nodes for the org, repos, teams and branch protection", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      "org/acme",
      "protection/acme/api/main",
      "repo/acme/api",
      "repo/acme/web",
      "team/acme/backend",
      "team/acme/everyone",
    ]);
    expect(g.groups.byStack.acme).toHaveLength(g.nodes.length);
  });

  test("team access and protection edges", () => {
    expect(edge(g, "team/acme/backend", "repo/acme/api")?.viaAttr).toBe("access:write");
    expect(edge(g, "team/acme/backend", "repo/acme/web")).toBeUndefined();
    expect(edge(g, "team/acme/everyone", "repo/acme/api")?.viaAttr).toBe("access:read");
    expect(edge(g, "team/acme/everyone", "repo/acme/web")?.viaAttr).toBe("access:read");
    expect(edge(g, "protection/acme/api/main", "repo/acme/api")).toBeDefined();
  });

  test("a team's repo the policy does not declare is dangling, not a node", () => {
    expect(g.dangling).toEqual([{ from: "team/acme/backend", kind: "ref", path: "repos", value: "ghost" }]);
  });

  test("a document with no orgs is an empty graph", () => {
    expect(readGovernance(undefined).nodes).toEqual([]);
  });
});

describe("the reader module", () => {
  const dir = mkdtempSync(join(tmpdir(), "fw-graph-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads governance.yml from the member's directory", () => {
    mkdirSync(join(dir, "m"));
    writeFileSync(join(dir, "m", "governance.yml"), POLICY);
    expect(read({ dir: join(dir, "m"), config: {} }).nodes).toHaveLength(6);
  });
});
