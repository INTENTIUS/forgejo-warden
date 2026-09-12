// The same policy as governance.yml, as data in TypeScript. The type gives
// completion and a compile error on a misspelt key; the helper in helpers.ts
// is the part YAML cannot express without anchors. By default warden folds
// this file to its value without running it (--config-mode fold); it is typed
// JSON. The export is named because the statically evaluable subset admits
// named exports only (spec F-Scan); `policy` is the name warden looks for.
import type { GovernanceConfig } from "@intentius/forgejo-warden";
import { service } from "./helpers.ts";

export const policy = {
  orgs: {
    "my-org": {
      settings: {
        description: "Engineering",
        visibility: "limited",
      },
      repos: {
        api: service("api"),
        web: service("web"),
      },
    },
  },
} satisfies GovernanceConfig;
