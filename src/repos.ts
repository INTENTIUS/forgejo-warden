/**
 * `forgejo-warden repos`: the org's repository list in the format
 * `chant workspace check --forge-repos <file>` reads (chant#3168).
 *
 * chant never asks the forge itself. An org workspace (`scope: "org"`) holds
 * one `repo` member per repository, and chant compares those members with
 * this list: a repository the forge lists that no member names is WSP014, a
 * member naming one the forge no longer lists is WSP015. Archived
 * repositories are listed with `archived: true`; chant does not ask for them
 * to be declared, and a member naming one is not a drop.
 *
 * The output shape is shared by the three wardens (chant#5069); only the
 * `forge` value differs.
 */

import type { ForgejoClient } from "./auth/client.js";

/** The `forge` value forgejo-warden writes. */
export const FORGE = "forgejo";

/** One repository, as `--forge-repos` reads it. `archived` is present only when true. */
export interface ForgeRepoEntry {
  url: string;
  archived?: true;
}

/** The document `repos` writes. */
export interface ForgeRepoListFile {
  forge: typeof FORGE;
  org: string;
  repos: ForgeRepoEntry[];
}

/** The fields of Forgejo's repository object the list reads. */
interface ForgejoRepo {
  name: string;
  full_name?: string;
  html_url?: string;
  archived?: boolean;
}

const PAGE_LIMIT = 50;

/**
 * Every repository of `org`, archived ones included, one page of
 * `GET /orgs/{org}/repos` at a time. Unlike the cycles' paginator, a 404 is
 * an error here: an org the instance does not have would otherwise read as
 * an org with no repositories, and chant would report every member dropped.
 */
export async function listOrgRepos(client: ForgejoClient, org: string): Promise<ForgejoRepo[]> {
  const out: ForgejoRepo[] = [];
  for (let page = 1; ; page++) {
    const chunk = await client.request<ForgejoRepo[]>("GET", `/orgs/${encodeURIComponent(org)}/repos?limit=${PAGE_LIMIT}&page=${page}`);
    if (!Array.isArray(chunk)) throw new Error(`GET /orgs/${org}/repos did not return a list`);
    out.push(...chunk);
    if (chunk.length < PAGE_LIMIT) return out;
  }
}

/**
 * The repository's web URL: Forgejo's `html_url`, or, when the instance
 * leaves it out, `<baseUrl>/<full_name>`. chant compares URLs by host, owner
 * and name, so a declaration's clone URL (https, ssh or scp-style, with or
 * without `.git`) matches it.
 */
function repoUrl(repo: ForgejoRepo, org: string, baseUrl: string): string {
  if (repo.html_url) return repo.html_url;
  return `${baseUrl.replace(/\/+$/, "")}/${repo.full_name ?? `${org}/${repo.name}`}`;
}

/** The `--forge-repos` document for `org`, sorted by URL so a re-run with no change writes the same bytes. */
export async function forgeRepoList(client: ForgejoClient, org: string, baseUrl: string): Promise<ForgeRepoListFile> {
  const repos = (await listOrgRepos(client, org))
    .map((r): ForgeRepoEntry => ({ url: repoUrl(r, org, baseUrl), ...(r.archived === true ? { archived: true as const } : {}) }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { forge: FORGE, org, repos };
}

/**
 * The org `repos` lists: `--org` when given, which must be one of the
 * policy's orgs, else the policy's only org. Throws a message for the CLI's
 * exit 2 otherwise.
 */
export function pickOrg(policyOrgs: string[], requested: string | undefined): string {
  if (requested !== undefined) {
    if (!policyOrgs.includes(requested)) {
      throw new Error(`--org ${requested} is not an org the policy governs (${policyOrgs.join(", ") || "none"})`);
    }
    return requested;
  }
  if (policyOrgs.length === 1) return policyOrgs[0]!;
  if (policyOrgs.length === 0) throw new Error("the policy governs no org");
  throw new Error(`the policy governs ${policyOrgs.length} orgs (${policyOrgs.join(", ")}); pick one with --org <name>`);
}
