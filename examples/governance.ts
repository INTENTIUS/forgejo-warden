// The same policy as governance.yml, as data in TypeScript. The type gives
// completion and a compile error on a misspelt key; the helper is the part
// YAML cannot express without anchors. By default warden folds this file to
// its value without running it (--config-mode fold); it is typed JSON.
import type { GovernanceConfig } from "@intentius/forgejo-warden";

const protectedMain = {
  ruleName: "main",
  requiredApprovals: 1,
  enableStatusCheck: true,
  statusCheckContexts: ["ci"],
  dismissStaleApprovals: true,
};

const service = (name: string) => ({
  hasWiki: false,
  hasPullRequests: true,
  allowSquashMerge: true,
  topics: ["service", name],
  branchProtection: [protectedMain],
});

export default {
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
