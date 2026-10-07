// The same policy as governance.yml, as data in TypeScript. The type gives
// completion and a compile error on a misspelt key; the preset is the part
// YAML cannot express without anchors. By default warden folds this file to
// its value without running it (--config-mode fold); it is typed JSON.
import type { GovernanceConfig } from "@intentius/forgejo-warden";

// One review policy, several settings. When a field it sets drifts, the plan
// names the argument it came from and the line that argument is on.
const reviewPreset = (review: { approvals: number; squashOnly: boolean }) => ({
  allowSquashMerge: true,
  allowMergeCommits: !review.squashOnly,
  allowRebase: !review.squashOnly,
  branchProtection: [
    {
      ruleName: "main",
      requiredApprovals: review.approvals,
      enableStatusCheck: true,
      statusCheckContexts: ["ci"],
      dismissStaleApprovals: true,
    },
  ],
});

export default {
  orgs: {
    "my-org": {
      settings: {
        description: "Engineering",
        visibility: "limited",
      },
      repos: {
        api: {
          ...reviewPreset({ approvals: 2, squashOnly: true }),
          hasWiki: false,
          hasPullRequests: true,
          topics: ["service", "api"],
        },
        web: {
          ...reviewPreset({ approvals: 1, squashOnly: false }),
          hasWiki: false,
          hasPullRequests: true,
          topics: ["service", "web"],
        },
      },
    },
  },
} satisfies GovernanceConfig;
