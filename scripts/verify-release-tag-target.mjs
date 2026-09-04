#!/usr/bin/env node

import { runReleaseToolingGh } from "./release-tooling-identity.mjs";

// Plain Node: this verifier runs from a sparse trusted-tooling checkout without
// installed dependencies, immediately before each publication operation.
try {
  const [repository, tag, expectedSha, ...extra] = process.argv.slice(2);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
    !tag ||
    !/^[a-f0-9]{40}$/u.test(expectedSha ?? "") ||
    extra.length
  ) {
    throw new Error(
      "Usage: verify-release-tag-target.mjs <owner/repo> <tag> <validated-commit-sha>",
    );
  }
  // The full namespace avoids a same-named branch. The commits endpoint peels
  // annotated tags to the commit, matching admission's ^{commit} identity.
  const ref = encodeURIComponent(`refs/tags/${tag}`);
  let actualSha;
  try {
    actualSha = runReleaseToolingGh([
      "api",
      `repos/${repository}/commits/${ref}`,
      "--method",
      "GET",
      "--jq",
      ".sha",
    ]).trim();
  } catch {
    throw new Error(`Release tag ${tag} is missing or unreadable; refusing publication.`);
  }
  if (actualSha !== expectedSha) {
    throw new Error(
      `Release tag ${tag} no longer matches validated commit ${expectedSha}; refusing publication.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[verify-release-tag-target] FAILED (exit 1)");
  process.exitCode = 1;
}
