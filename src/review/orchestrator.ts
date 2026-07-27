import * as core from "@actions/core";
import { Octokit, Repo } from "../github/client";
import {
  Config,
  FileKind,
  ReviewResult,
  StoredFile,
  StoredFinding,
} from "../types";
import { DiffFile, parseDiffFiles } from "../github/diff";
import { ReviewState, readState, writeSummary } from "../github/state";
import {
  buildInlineComments,
  ExistingComments,
  findingId,
  postReview,
  readExistingComments,
} from "../github/review";
import { getLinkedIssues, getPrDetails, PrDetails } from "./context";
import { resolveScope } from "./scope";
import { selectFiles } from "./chunker";
import { planBatches } from "./batch";
import { ReviewEngine } from "./engine";
import {
  buildSystemPrompt,
  buildUserPrompt,
  PriorFindingContext,
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
  let base: ReviewState = opts.forceFull
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
  const renamedPaths = new Map(
    allFiles
      .filter((file) => !file.isDeleted && file.oldPath !== file.path)
      .map((file) => [file.oldPath, file.path]),
  );
  if (renamedPaths.size > 0) {
    base = withRenamedPaths(base, renamedPaths);
    core.info(`Updated stored state for ${renamedPaths.size} renamed file(s).`);
  }
  const deletedPaths = new Set(
    dropped.filter((d) => d.reason === "deleted").map((d) => d.path),
  );
  if (deletedPaths.size > 0) {
    const removed = base.findings.filter((f) => deletedPaths.has(f.p)).length;
    base = withoutPaths(base, deletedPaths);
    core.info(
      `Removed ${removed} finding(s) for ${deletedPaths.size} deleted file(s).`,
    );
  }

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
  const meta = {
    title: pr.title,
    description: pr.body,
    linkedIssues,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    incremental: scope.kind === "incremental",
  };

  // Load prior comments before model calls so incremental prompts can reconcile
  // existing findings and outdated comments can be refreshed on this commit.
  const existing = await readExistingComments(octokit, repo, pull_number);

  // Every selected file is reviewed. When they don't all fit in one request we
  // send several — splitting the work, never dropping any of it.
  const batches = planBatches(files, config.batch_chars);
  core.info(
    `Reviewing ${files.length} file(s) [${scope.kind}] with ${config.profile} profile` +
      (batches.length > 1 ? ` across ${batches.length} request(s)` : "") +
      "…",
  );

  const partials: ReviewResult[] = [];
  const suppliedPriorFindings: PriorFindingContext[] = [];
  let tokens = 0;
  let failed = 0;

  for (const [i, batch] of batches.entries()) {
    const label =
      batches.length > 1
        ? `Batch ${i + 1}/${batches.length} (${batch.length} file(s))`
        : `${batch.length} file(s)`;
    const priorFindings = meta.incremental
      ? priorFindingsForBatch(batch, base.findings, existing)
      : [];
    const priorIds = new Set(priorFindings.map((finding) => finding.id));
    const user = buildUserPrompt(meta, batch, config, priorFindings);

    let partial: ReviewResult;
    try {
      const draft = await engine.review(system, user);
      tokens += draft.usage.total;
      partial = draft.result;
    } catch (err: any) {
      // One failed batch must not throw away the batches that succeeded.
      failed++;
      core.warning(`${label} failed to review (${err.message}); skipping it.`);
      continue;
    }

    if (
      config.verification &&
      (partial.findings.length > 0 ||
        partial.prior_finding_verdicts.length > 0 ||
        priorFindings.length > 0)
    ) {
      core.info(
        `${label}: verifying ${partial.findings.length} finding(s) and ${priorFindings.length} prior finding(s)…`,
      );
      try {
        const verified = await engine.verify(
          verificationPrompt(),
          user,
          partial,
        );
        tokens += verified.usage.total;
        // The verify pass returns a whole fresh result, so anything the model
        // forgot to echo back would otherwise be silently lost.
        partial = {
          overall_assessment:
            verified.result.overall_assessment.trim() ||
            partial.overall_assessment,
          findings: verified.result.findings,
          observations: verified.result.observations.length
            ? verified.result.observations
            : partial.observations,
          prior_finding_verdicts:
            verified.result.prior_finding_verdicts.length > 0
              ? verified.result.prior_finding_verdicts
              : partial.prior_finding_verdicts,
        };
      } catch (err: any) {
        core.warning(
          `${label}: verification pass failed (${err.message}); keeping draft.`,
        );
      }
    }
    partial = {
      ...partial,
      prior_finding_verdicts: partial.prior_finding_verdicts.filter((verdict) =>
        priorIds.has(verdict.id),
      ),
    };
    suppliedPriorFindings.push(...priorFindings);
    partials.push(partial);
  }

  if (partials.length === 0) {
    throw new Error(
      `All ${batches.length} review request(s) failed; leaving the PR untouched.`,
    );
  }
  if (failed > 0) {
    core.warning(
      `${failed} of ${batches.length} batch(es) failed; the report covers the rest.`,
    );
  }

  const result: ReviewResult = mergeResults(partials);
  const suppliedPriorIds = new Set(
    suppliedPriorFindings.map((finding) => finding.id),
  );
  const priorVerdicts = result.prior_finding_verdicts.filter((verdict) =>
    suppliedPriorIds.has(verdict.id),
  );
  const findingAliases = priorFindingAliases(
    result.findings,
    suppliedPriorFindings,
  );

  const { comments, unanchored, duplicates } = buildInlineComments(
    result.findings,
    files,
    existing,
    findingAliases,
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
    .filter((finding) => !unanchored.includes(finding))
    .map((finding) => {
      const stored = toStoredFinding(finding);
      return { ...stored, id: findingAliases.get(stored.id) ?? stored.id };
    });

  const { findings, expired } = mergeFindings(
    base.findings,
    freshFindings,
    existing.byId,
    priorVerdicts,
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
      `${unanchored.length} demoted to observations, ${expired.length} resolved. ` +
      `Totals: ${findings.length} finding(s) across ${roster.length} file(s)` +
      (skippedByCap > 0 ? `; ${skippedByCap} file(s) over max_files` : "") +
      ".",
  );
}

/**
 * Fold per-batch results into one. Findings and observations concatenate — each
 * batch saw a disjoint set of files, so there is nothing to dedupe here;
 * `mergeFindings` handles identity against previous runs downstream.
 */
function mergeResults(partials: ReviewResult[]): ReviewResult {
  if (partials.length === 1) return partials[0];

  const assessments = partials
    .map((p) => p.overall_assessment.trim())
    .filter((a) => a.length > 0);

  return {
    overall_assessment: assessments.join(" "),
    findings: partials.flatMap((p) => p.findings),
    observations: partials.flatMap((p) => p.observations),
    prior_finding_verdicts: partials.flatMap(
      (p) => p.prior_finding_verdicts,
    ),
  };
}

export function priorFindingsForBatch(
  batch: DiffFile[],
  findings: StoredFinding[],
  existing: ExistingComments,
): PriorFindingContext[] {
  const currentPath = new Map<string, string>();
  for (const file of batch) {
    currentPath.set(file.path, file.path);
    currentPath.set(file.oldPath, file.path);
  }

  return findings.flatMap((finding) => {
    const path = currentPath.get(finding.p);
    if (!path) return [];
    const status = existing.byId.get(finding.id);
    return [
      {
        id: finding.id,
        path,
        line: status && !status.outdated ? status.line : finding.l,
        severity: finding.s,
        title: status?.title ?? finding.h ?? finding.t,
        summary: finding.t,
      },
    ];
  });
}

export function withoutPaths(
  state: ReviewState,
  paths: Set<string>,
): ReviewState {
  if (paths.size === 0) return state;
  return {
    ...state,
    findings: state.findings.filter((finding) => !paths.has(finding.p)),
    observations: state.observations.filter((note) => !paths.has(note.p)),
    files: state.files.filter((file) => !paths.has(file.p)),
  };
}

export function withRenamedPaths(
  state: ReviewState,
  renamedPaths: Map<string, string>,
): ReviewState {
  if (renamedPaths.size === 0) return state;
  const currentPath = (path: string) => renamedPaths.get(path) ?? path;
  return {
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      p: currentPath(finding.p),
    })),
    observations: state.observations.map((note) => ({
      ...note,
      p: currentPath(note.p),
    })),
    files: state.files.map((file) => ({ ...file, p: currentPath(file.p) })),
  };
}

export function priorFindingAliases(
  findings: ReviewResult["findings"],
  priorFindings: PriorFindingContext[],
): Map<string, string> {
  const priorIdByNaturalId = new Map<string, string | null>();
  for (const prior of priorFindings) {
    const naturalId = findingId(prior.path, prior.title);
    const current = priorIdByNaturalId.get(naturalId);
    if (current === undefined) priorIdByNaturalId.set(naturalId, prior.id);
    else if (current !== prior.id) priorIdByNaturalId.set(naturalId, null);
  }

  const aliases = new Map<string, string>();
  for (const finding of findings) {
    const naturalId = findingId(finding.path, finding.title);
    const priorId = priorIdByNaturalId.get(naturalId);
    if (priorId) aliases.set(naturalId, priorId);
  }
  return aliases;
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
