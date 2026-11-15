import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The policy file a run reads. An explicit `--config` wins. Without one,
 * `governance.yml` in the working directory, or `governance.ts` there when
 * the `.yml` is absent. Undefined when none of them exists.
 */
export function resolveConfigPath(explicit: string | undefined, cwd: string = process.cwd()): string | undefined {
  if (explicit) return explicit;
  for (const name of ["governance.yml", "governance.ts"]) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}
