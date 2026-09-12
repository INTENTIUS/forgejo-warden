/**
 * The governance policy, loaded from YAML, JSON, or TypeScript.
 *
 * A `.ts` policy is data: an object literal typed by `GovernanceConfig`,
 * exported as `policy` (a default export does not fold; the subset admits named
 * exports only). By default it is *folded*, reduced
 * to its value by `@intentius/tsad-reference` without being run, so the plan
 * is a function of the file and nothing else and no code executes to produce
 * it. `run` mode imports the file instead, for a user who wants typed JSON and
 * does not care how it was evaluated; `check` mode does both and refuses if
 * they differ, which is the guarantee folding provides made visible.
 *
 * Selective-by-omission survives either way: an `undefined`-valued property
 * is treated as absent, the same as JSON would leave it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { GovernanceConfig } from "./types.js";

export type ConfigMode = "fold" | "run" | "check";

export class GovernanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceConfigError";
  }
}

/** Every `.ts` file under the policy's directory, keyed relative to it, so the policy may import siblings. */
function projectFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
        files.set(relative(root, abs).split("\\").join("/"), readFileSync(abs, "utf-8"));
      }
    }
  };
  walk(root);
  return files;
}

function policyOf(exports: Record<string, unknown>, where: string): unknown {
  // Named, not default: the statically evaluable subset admits named exports
  // only (spec F-Scan), so `export const policy` is the form that folds. A
  // default export is accepted in run mode for a file that was never meant to
  // fold.
  if ("policy" in exports) return exports.policy;
  if ("default" in exports) return exports.default;
  throw new GovernanceConfigError(`${where} must export the policy as \`export const policy\``);
}

/** Fold the policy with the reference evaluator: no execution, a located refusal if the file is not data. */
async function foldPolicy(path: string): Promise<unknown> {
  const { foldProject } = await import("@intentius/tsad-reference");
  const root = dirname(resolve(path));
  const key = relative(root, resolve(path)).split("\\").join("/");
  const verdicts = foldProject(projectFiles(root)).verdicts;
  const verdict = verdicts.get(key);
  if (!verdict) throw new GovernanceConfigError(`${path}: not found among the project's files`);
  if (verdict.kind === "run") {
    throw new GovernanceConfigError(`${path} is not data (${verdict.rule}): ${verdict.reason}`);
  }
  return policyOf(Object.fromEntries(verdict.exports), path);
}

/** Import the policy: whatever the file does, its export is the policy. */
async function runPolicy(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  return policyOf(mod, path);
}

/** JSON's view of a value: `undefined` properties absent, keys sorted, so two loads compare as the policy the cycles will read. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}

function assertShape(raw: unknown, path: string): GovernanceConfig {
  if (!raw || typeof raw !== "object" || typeof (raw as { orgs?: unknown }).orgs !== "object") {
    throw new GovernanceConfigError(`${path}: config must be an object with an \`orgs\` map`);
  }
  // The cycles read through JSON's view of the policy, where an undefined
  // property is absent. Normalise once here so fold and run agree by construction.
  return JSON.parse(JSON.stringify(raw)) as GovernanceConfig;
}

export async function loadGovernanceConfig(path: string, mode: ConfigMode = "fold"): Promise<GovernanceConfig> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts")) {
    if (mode === "run") return assertShape(await runPolicy(path), path);
    const folded = await foldPolicy(path);
    if (mode === "check") {
      const ran = await runPolicy(path);
      if (canonical(folded) !== canonical(ran)) {
        throw new GovernanceConfigError(`${path}: folding and running the policy disagree, so the file is not data; the run result is ${canonical(ran)} and the fold is ${canonical(folded)}`);
      }
    }
    return assertShape(folded, path);
  }
  const text = readFileSync(path, "utf-8");
  return assertShape(lower.endsWith(".json") ? JSON.parse(text) : parseYaml(text), path);
}
