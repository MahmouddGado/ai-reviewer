import * as core from "@actions/core";
import { Octokit, Repo } from "../github/client";
import { Config, FileKind, ReviewResult, StoredFile } from "../types";
import { parseDiffFiles } from "../github/diff";
import { ReviewState, readState, writeSummary } from "../github/state";
import {
  buildInlineComments,
  postReview,
  readExistingComments,
} from "../github/review";
import { getLinkedIssues, getPrDetails, PrDetails } from "./context";
import { resolveScope } from "./scope";
import { selectFiles } from "./chunker";
import { ReviewEngine } from "./engine";
import {
  buildSystemPrompt,
  buildUserPrompt,
  verificationPrompt,
} from "./prompts";
import {
  applyIssueCounts,
  buildRoster,
  mergeRoster,
  renderSummaryComment,
} from "./render";
import {
  dropObservationsWithComments,
  findingToObservation,
  mergeFindings,
  mergeObservations,
  toStoredFinding,
  toStoredObservation,
} from "./accumulate";

export interface RunOptions {
  forceFull: boolean; // full review vs incremental
  summaryOnly: boolean; // only re-render the sticky summary
}

export async function runReview(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
  config: Config,
  engine: ReviewEngine,
  opts: RunOptions,
): Promise<void> {
  const pr = await getPrDetails(octokit, repo, pull_number);
  const prev = await readState(octokit, repo, pull_number);

  // `@bot summary` just redraws the sticky comment from what we already know —
  // no diff, no model call, no tokens.
  if (opts.summaryOnly) {
    await publishSummary(octokit, repo, pr, prev, engine.model);
    core.info("Re-rendered the summary comment from stored state.");
    return;
  }

  // A full review rebuilds the totals from scratch; that's the escape hatch if
  // accumulation ever drifts.
  const base: ReviewState = opts.forceFull
    ? { ...prev, findings: [], observations: [], files: [] }
    : prev;

  const scope = await resolveScope(octokit, repo, pr, prev, opts.forceFull);
  if (!scope.hasChanges) {
    core.info("No reviewable changes in scope. Nothing to do.");
    await publishSummary(octokit, repo, pr, advance(base, pr, 0, false), engine.model);
    return;
  }

  const allFiles = parseDiffFiles(scope.diffText);
  const { files, dropped, skippedByCap } = selectFiles(allFiles, config);
  if (files.length === 0) {
    core.info("All changed files were filtered out. Nothing to review.");
    const roster = buildRoster(
      allFiles.map((f) => f.path),
      new Map(dropped.map((d) => [d.path, d.reason as FileKind])),
      new Map(),
    );
    const next = advance(base, pr, 0, false);
    next.files = mergeRoster(base.files, roster);
    await publishSummary(octokit, repo, pr, next, engine.model);
    return;
  }

  const linkedIssues = await getLinkedIssues(octokit, repo, pr.body);
  const system = buildSystemPrompt(config);
  const user = buildUserPrompt(
    {
      title: pr.title,
      description: pr.body,
      linkedIssues,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      incremental: scope.kind === "incremental",
    },
    files,
    config,
  );

  core.info(
    `Reviewing ${files.length} file(s) [${scope.kind}] with ${config.profile} profile…`,
  );
  const draft = await engine.review(system, user);
  let result: ReviewResult = draft.result;
  let tokens = draft.usage.total;

  if (config.verification && result.findings.length > 0) {
    core.info(`Verifying ${result.findings.length} finding(s)…`);
    try {
      const verified = await engine.verify(verificationPrompt(), user, result);
      tokens += verified.usage.total;
      // The verify pass returns a whole fresh result, so anything the model
      // forgot to echo back would otherwise be silently lost.
      result = {
        overall_assessment:
          verified.result.overall_assessment.trim() ||
          draft.result.overall_assessment,
        findings: verified.result.findings,
        observations: verified.result.observations.length
          ? verified.result.observations
          : draft.result.observations,
      };
    } catch (err: any) {
      core.warning(`Verification pass failed (${err.message}); keeping draft.`);
    }
  }

  // Always read existing comments, including on full runs — GitHub does not
  // dedupe, so skipping this re-posts every comment on `@bot full review`.
  const existing = await readExistingComments(octokit, repo, pull_number);

  const { comments, unanchored, duplicates } = buildInlineComments(
    result.findings,
    files,
    existing,
  );

  await postReview(
    octokit,
    repo,
    pull_number,
    pr.headSha,
    reviewBody(files.length, pr.headSha, comments.length),
    comments,
  );

  /* ---- fold this run into the running totals ---- */

  const reviewedPaths = new Set(files.map((f) => f.path));
  const freshFindings = result.findings
    .filter((f) => !unanchored.includes(f))
    .map(toStoredFinding);

  const { findings, expired } = mergeFindings(
    base.findings,
    freshFindings,
    existing.byId,
  );

  const freshObservations = [
    ...result.observations.map(toStoredObservation),
    ...unanchored.map(findingToObservation),
  ];
  const observations = dropObservationsWithComments(
    mergeObservations(base.observations, freshObservations, reviewedPaths),
    findings,
  );

  const issueCounts = new Map<string, number>();
  for (const f of findings) issueCounts.set(f.p, (issueCounts.get(f.p) ?? 0) + 1);
  const roster: StoredFile[] = applyIssueCounts(
    mergeRoster(
      base.files,
      buildRoster(
        allFiles.map((f) => f.path),
        new Map(dropped.map((d) => [d.path, d.reason as FileKind])),
        issueCounts,
      ),
    ),
    findings,
  );

  const next = advance(base, pr, tokens, true);
  next.findings = findings;
  next.observations = observations;
  next.files = roster;
  next.assessment = result.overall_assessment.trim() || base.assessment;

  await publishSummary(octokit, repo, pr, next, engine.model);

  core.info(
    `Done. ${comments.length} new comment(s), ${duplicates.length} duplicate(s) skipped, ` +
      `${unanchored.length} demoted to observations, ${expired.length} expired. ` +
      `Totals: ${findings.length} finding(s) across ${roster.length} file(s)` +
      (skippedByCap > 0 ? `; ${skippedByCap} file(s) over max_files` : "") +
      ".",
  );
}

/** Bump the counters that advance regardless of what the review found. */
function advance(
  base: ReviewState,
  pr: PrDetails,
  tokens: number,
  counted: boolean,
): ReviewState {
  return {
    ...base,
    lastReviewedSha: pr.headSha,
    reviewCount: base.reviewCount + (counted ? 1 : 0),
    tokens: base.tokens + tokens,
  };
}

/**
 * Render and upsert the sticky comment. The state marker shares the comment body
 * with the rendered block, so the renderer is handed whatever space is left.
 */
async function publishSummary(
  octokit: Octokit,
  repo: Repo,
  pr: PrDetails,
  state: ReviewState,
  model: string,
): Promise<void> {
  const next: ReviewState = { ...state, model };
  await writeSummary(octokit, repo, pr.number, next, (budget) => {
    const { body, degradation, dropped } = renderSummaryComment(
      {
        findings: next.findings,
        observations: next.observations,
        files: next.files,
        assessment: next.assessment,
        model,
        tokens: next.tokens,
      },
      budget,
    );
    if (degradation !== "none") {
      core.warning(
        `Summary shrunk to fit GitHub's comment limit (level: ${degradation}${
          dropped ? `, ${dropped} row(s) hidden` : ""
        }).`,
      );
    }
    return body;
  });
}

/**
 * The review object exists only to carry the inline comments; the full report
 * lives in the sticky comment so it can be updated in place on every push.
 */
function reviewBody(
  reviewed: number,
  headSha: string,
  comments: number,
): string {
  const noun = comments === 1 ? "comment" : "comments";
  return `Reviewed ${reviewed} file(s) at \`${headSha.slice(0, 7)}\` — ${comments} new inline ${noun}. See the **Code Review Summary** comment for the full report.`;
}
