import { strict as assert } from "node:assert";
import { it } from "node:test";
import { DEFAULT_STATE, encodeState, parseState, ReviewState } from "../github/state";
import { Octokit } from "../github/client";
import { ConfigSchema, ReviewResultSchema } from "../types";
import { ReviewEngine } from "./engine";
import { runReview } from "./orchestrator";

it("replaces current findings and archives each review, including reruns at the same SHA", async () => {
  const initial: ReviewState = {
    ...DEFAULT_STATE, lastReviewedSha: "old", summarySha: "old", reviewCount: 1,
    model: "previous-model", usage: { input: 900, output: 100, cached: 20 },
    findings: [{ id: "old-id", p: "old.ts", l: 1, s: "WARNING", t: "Previous problem" }],
    files: [{ p: "old.ts", k: "code", n: 1 }],
  };
  let body = `<!-- kilo-review -->\n${encodeState(initial)}`;
  let calls = 0;
  let headSha = "new";
  let incomplete = false;
  let fail = false;
  const diff = "diff --git a/new.ts b/new.ts\n--- a/new.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const octokit = {
    rest: {
      pulls: { get: async (args: { mediaType?: unknown }) => ({ data: args.mediaType ? diff : {
        number: 1, title: "Change", body: "", base: { ref: "main", sha: "base" }, head: { ref: "feature", sha: headSha }, draft: false,
      } }), listReviewComments: "reviews" },
      repos: { compareCommitsWithBasehead: async () => ({ data: diff }) },
      issues: { listComments: "comments", updateComment: async (args: { body: string }) => { body = args.body; } },
    },
    paginate: async (method: string) => method === "comments" ? [{ id: 1, body }] : [],
  } as unknown as Octokit;
  const engine = {
    model: "glm-5.3",
    review: async () => {
      calls++;
      if (fail) throw new Error("Provider unavailable");
      return { result: ReviewResultSchema.parse({ file_reviews: [{ path: "new.ts", summary: "clean; updated value" }] }), usage: { input: 10, output: 5, cached: 0 }, incomplete };
    },
  } as unknown as ReviewEngine;
  const run = (forceFull = false) => runReview(octokit, { owner: "owner", repo: "repo" }, 1, ConfigSchema.parse({ verification: false }), engine, { forceFull, summaryOnly: false });
  await run();
  const next = parseState(body)!;
  assert.deepEqual(next.findings, []);
  assert.deepEqual(next.history[0].findings, initial.findings);
  assert.deepEqual(next.history[0].usage, initial.usage);
  assert.equal(next.history[0].model, "previous-model");
  assert.deepEqual(next.usage, { input: 10, output: 5, cached: 0 });
  assert.ok(!body.split("<!-- kilo-review-history -->")[0].includes("Previous problem"));
  await run();
  assert.equal(calls, 1, "same-SHA automatic event must be a no-op");
  await run(true);
  await run(true);
  assert.deepEqual(parseState(body)!.history.map((review) => review.sha), ["new", "new", "old"]);
  headSha = "next";
  incomplete = true;
  await run();
  assert.equal(parseState(body)!.lastReviewedSha, "new");
  assert.equal(parseState(body)!.summarySha, "next");
  assert.equal(parseState(body)!.files[0].k, "failed");
  assert.match(body, /Review Incomplete/);
  fail = true;
  await run();
  assert.equal(parseState(body)!.lastReviewedSha, "new");
  assert.equal(parseState(body)!.files[0].k, "failed");
  assert.match(body, /Review Incomplete/);
});
