import { execFileSync } from "node:child_process";
import { createScanner, assertAuditEnvironment, locationDigest } from "./public-audit.mjs";

export async function auditHostedMetadata(root, repository, literals = [], readApi) {
  assertAuditEnvironment();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid hosted repository identity");
  const api =
    readApi ??
    ((path, paginated = false) => {
      try {
        return JSON.parse(
          execFileSync("gh", ["api", ...(paginated ? ["--paginate", "--slurp"] : []), path], {
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      } catch {
        throw new Error("Hosted evidence could not be read completely");
      }
    });
  const prefix = `repos/${repository}`;
  const metadata = await api(prefix);
  const branch = metadata.default_branch;
  if (typeof branch !== "string" || !branch || metadata.has_wiki || metadata.has_discussions)
    throw new Error("Additional hosted surfaces need an explicit audit route");
  const before = (await api(`${prefix}/commits/${encodeURIComponent(branch)}`)).sha;
  if (typeof before !== "string" || !/^[a-f0-9]{40,64}$/.test(before))
    throw new Error("Invalid hosted head");
  const scanner = await createScanner(root, literals);
  const findings = await scanner.scan(
    Buffer.from(JSON.stringify({ repository, metadata })),
    "repository-metadata.json",
    "hosted_repository",
  );
  const counts = {};
  for (const [kind, path] of [
    ["releases", `${prefix}/releases?per_page=100`],
    ["issues_and_prs", `${prefix}/issues?state=all&per_page=100`],
    ["issue_comments", `${prefix}/issues/comments?per_page=100`],
    ["review_comments", `${prefix}/pulls/comments?per_page=100`],
    ["commit_comments", `${prefix}/comments?per_page=100`],
  ]) {
    const pages = await api(path, true);
    if (!Array.isArray(pages) || pages.length > 100 || pages.some((page) => !Array.isArray(page)))
      throw new Error("Incomplete hosted pagination");
    const rows = pages.flat();
    counts[kind] = rows.length;
    for (const row of rows) {
      if (kind === "releases" && Array.isArray(row.assets) && row.assets.length)
        throw new Error("Release assets require a separate bounded artifact audit");
      findings.push(
        ...(await scanner.scan(
          Buffer.from(JSON.stringify(row)),
          `${kind}-metadata.json`,
          `hosted_${kind}`,
        )),
      );
      if (kind === "issues_and_prs" && row.pull_request) {
        if (!Number.isSafeInteger(row.number) || row.number < 1)
          throw new Error("Invalid pull request identity");
        const reviewPages = await api(`${prefix}/pulls/${row.number}/reviews?per_page=100`, true);
        if (
          !Array.isArray(reviewPages) ||
          reviewPages.length > 100 ||
          reviewPages.some((page) => !Array.isArray(page))
        )
          throw new Error("Incomplete review pagination");
        counts.reviews = (counts.reviews ?? 0) + reviewPages.flat().length;
        for (const review of reviewPages.flat())
          findings.push(
            ...(await scanner.scan(
              Buffer.from(JSON.stringify(review)),
              "review-metadata.json",
              "hosted_reviews",
            )),
          );
      }
    }
  }
  const after = (await api(`${prefix}/commits/${encodeURIComponent(branch)}`)).sha;
  if (before !== after) throw new Error("Hosted head changed during auditing");
  return {
    schema_version: "public-audit/1",
    scope: "current_hosted_metadata",
    observed_at: new Date().toISOString(),
    repository_digest: locationDigest(repository),
    head: before,
    counts,
    scanned_bytes: scanner.bytes(),
    findings,
    passed: findings.length === 0,
  };
}
