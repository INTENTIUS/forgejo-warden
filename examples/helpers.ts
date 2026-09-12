// Helpers the policy calls. A project-local function folds by interpretation
// when its body is one expression or consts and a return (spec S-FnBody), and
// a call into a sibling file is the form the subset admits (the import names
// the .ts extension so node can run the file too); a same-file arrow
// const called as a value is not (yet) data.
export function service(name: string) {
  return {
    hasWiki: false,
    hasPullRequests: true,
    allowSquashMerge: true,
    topics: ["service", name],
    branchProtection: [protectedMain],
  };
}

export const protectedMain = {
  ruleName: "main",
  requiredApprovals: 1,
  enableStatusCheck: true,
  statusCheckContexts: ["ci"],
  dismissStaleApprovals: true,
};
