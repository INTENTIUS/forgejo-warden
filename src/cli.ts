#!/usr/bin/env node
/**
 * forgejo-warden — governance reconcile CLI.
 *
 * Stub. The real subcommands (reconcile, …) land with the runner+CLI work
 * (issue #5). The bin launcher calls `run()`.
 */

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  void argv;
  process.stdout.write("forgejo-warden: not yet implemented (see the roadmap epic)\n");
}
