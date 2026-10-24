/**
 * The graph reader for a forge-governance member (INTENTIUS/chant#4413,
 * #3180): the governance YAML as graph IR. It reads the document and nothing
 * else, so it takes no Forgejo call and writes nothing, and it draws the policy
 * as declared. A node is an org, a repo, a team or a branch protection rule.
 * An edge is a team's access to a repo or a rule's repo. Forgejo has no
 * rulesets or apps in the policy, so there are none of either.
 */

type Obj = Record<string, unknown>;

export interface IRNode {
  id: string;
  kind: string;
  lexicon: string;
  attrs: Record<string, unknown>;
  sourceLoc?: { file: string };
}
export interface IREdge {
  from: string;
  to: string;
  kind: "ref";
  viaAttr?: string;
}
export interface IRDangling {
  from: string;
  kind: "ref";
  path: string;
  value: string;
}
export interface GraphIR {
  nodes: IRNode[];
  edges: IREdge[];
  groups: { byLexicon: Record<string, string[]>; byStack: Record<string, string[]> };
  dangling?: IRDangling[];
}

const LEXICON = "forgejo-warden";

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** The attributes of `from` that are set, so a node carries what the policy states and no more. */
function pick(from: Obj, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

export function readGovernance(doc: unknown, file?: string): GraphIR {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const dangling: IRDangling[] = [];
  const byStack: Record<string, string[]> = {};
  const sourceLoc = file ? { sourceLoc: { file } } : {};

  const orgs = isObj(doc) && isObj(doc.orgs) ? doc.orgs : {};
  for (const [orgName, rawOrg] of Object.entries(orgs)) {
    const org = isObj(rawOrg) ? rawOrg : {};
    const stack: string[] = (byStack[orgName] = []);
    const add = (id: string, kind: string, attrs: Record<string, unknown>) => {
      if (nodes.some((n) => n.id === id)) return;
      nodes.push({ id, kind, lexicon: LEXICON, attrs, ...sourceLoc });
      stack.push(id);
    };
    add(`org/${orgName}`, "Org", { name: orgName, ...(isObj(org.settings) ? { settings: org.settings } : {}) });

    const repos = isObj(org.repos) ? org.repos : {};
    const repoNames = Object.keys(repos);
    const repoId = (name: string) => `repo/${orgName}/${name}`;
    for (const name of repoNames) {
      const repo = isObj(repos[name]) ? (repos[name] as Obj) : {};
      add(repoId(name), "Repo", { name, org: orgName, ...pick(repo, ["private", "defaultBranch", "topics", "hasWiki", "hasPullRequests"]) });
      for (const bp of objs(repo.branchProtection)) {
        if (typeof bp.ruleName !== "string") continue;
        const id = `protection/${orgName}/${name}/${bp.ruleName}`;
        add(id, "BranchProtection", {
          ruleName: bp.ruleName,
          ...pick(bp, ["requiredApprovals", "enableStatusCheck", "enablePush", "requireSignedCommits", "dismissStaleApprovals"]),
        });
        edges.push({ from: id, to: repoId(name), kind: "ref", viaAttr: "branchProtection" });
      }
    }

    // Teams: a team names its repos, or has every repo of the org.
    const teams = isObj(org.teams) ? org.teams : {};
    for (const [slug, rawTeam] of Object.entries(teams)) {
      const team = isObj(rawTeam) ? rawTeam : {};
      const id = `team/${orgName}/${slug}`;
      add(id, "Team", { name: slug, org: orgName, ...pick(team, ["description", "permission", "includesAllRepositories"]), memberCount: objs(team.members).length });
      const access = `access:${String(team.permission ?? "read")}`;
      if (team.includesAllRepositories === true) {
        for (const n of repoNames) edges.push({ from: id, to: repoId(n), kind: "ref", viaAttr: access });
      }
      for (const r of objs(team.repos)) {
        if (typeof r.name !== "string") continue;
        if (!repoNames.includes(r.name)) dangling.push({ from: id, kind: "ref", path: "repos", value: r.name });
        else if (team.includesAllRepositories !== true) edges.push({ from: id, to: repoId(r.name), kind: "ref", viaAttr: access });
      }
    }
  }

  const ids = nodes.map((n) => n.id);
  return {
    nodes,
    edges,
    groups: { byLexicon: { [LEXICON]: ids }, byStack },
    ...(dangling.length ? { dangling } : {}),
  };
}
