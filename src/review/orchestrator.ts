import * as core from "@actions/core";
import { Octokit, Repo } from "../github/client";
import {
  Config,
  FileKind,
  ReviewResult,
  StoredFile,
  StoredFinding,
  TokenUsage,
} from "../types";
import { DiffFile, parseDiffFiles } from "../github/diff";
import {
  historyWithPrevious,
  ReviewState,
  readState,
  writeSummary,
} from "../github/state";
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
    await publishSummary(
      octokit,
      repo,
      pr,
      advance(base, pr, EMPTY_USAGE, false, scope.kind),
      engine.model,
    );
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
    const next = advance(base, pr, EMPTY_USAGE, false, scope.kind);
    next.summarySha = pr.headSha;
    next.scope = scope.kind;
    next.files = roster;
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
  const reviewedFiles: DiffFile[] = [];
  const failedPaths = new Set<string>();
  let usage: TokenUsage = { ...EMPTY_USAGE };
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
      usage = addUsage(usage, draft.usage);
      partial = draft.result;
    } catch (err: any) {
      // One failed batch must not throw away the batches that succeeded.
      failed++;
      for (const file of batch) failedPaths.add(file.path);
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
        usage = addUsage(usage, verified.usage);
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
          file_reviews: verified.result.file_reviews.length
            ? verified.result.file_reviews
            : partial.file_reviews,
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
      file_reviews: fileReviewsForBatch(partial.file_reviews, batch),
      prior_finding_verdicts: partial.prior_finding_verdicts.filter((verdict) =>
        priorIds.has(verdict.id),
      ),
    };
    reviewedFiles.push(...batch);
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
    reviewedFiles,
    existing,
    findingAliases,
  );

  await postReview(
    octokit,
    repo,
    pull_number,
    pr.headSha,
    reviewBody(reviewedFiles.length, pr.headSha, comments.length),
    comments,
  );

  /* ---- fold this run into the running totals ---- */

  const reviewedPaths = new Set(reviewedFiles.map((f) => f.path));
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
  for (const f of findings) {
    if (reviewedPaths.has(f.p)) {
      issueCounts.set(f.p, (issueCounts.get(f.p) ?? 0) + 1);
    }
  }
  const reviewNotes = buildFileReviewNotes(
    result.file_reviews,
    priorVerdicts,
    suppliedPriorFindings,
    issueCounts,
  );
  const droppedKinds = new Map<string, FileKind>(
    dropped.map((item) => [item.path, item.reason as FileKind]),
  );
  for (const path of failedPaths) droppedKinds.set(path, "failed");
  const roster: StoredFile[] = applyIssueCounts(
    buildRoster(
      allFiles.map((f) => f.path),
      droppedKinds,
      issueCounts,
      reviewNotes,
    ),
    findings.filter((finding) => reviewedPaths.has(finding.p)),
  );

  const next = advance(
    base,
    pr,
    usage,
    true,
    scope.kind,
    failed === 0,
  );
  next.findings = findings;
  next.observations = observations;
  next.files = roster;
  next.summarySha = pr.headSha;
  if ((prev.summarySha ?? prev.lastReviewedSha) !== pr.headSha) {
    next.history = historyWithPrevious(prev);
  }
  next.assessment = result.overall_assessment.trim() || base.assessment;

  await publishSummary(octokit, repo, pr, next, engine.model);

  core.info(
    `Done. ${comments.length} new comment(s), ${duplicates.length} duplicate(s) skipped, ` +
      `${unanchored.length} demoted to observations, ${expired.length} resolved. ` +
      `Totals: ${findings.length} open finding(s); this pass covered ${reviewedFiles.length} file(s)` +
      (skippedByCap > 0 ? `; ${skippedByCap} file(s) over max_files` : "") +
      (failed > 0 ? `; ${failedPaths.size} file(s) queued for retry` : "") +
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
    file_reviews: partials.flatMap((p) => p.file_reviews),
    prior_finding_verdicts: partials.flatMap(
      (p) => p.prior_finding_verdicts,
    ),
  };
}

function fileReviewsForBatch(
  reviews: ReviewResult["file_reviews"],
  batch: DiffFile[],
): ReviewResult["file_reviews"] {
  const allowed = new Set(batch.map((file) => file.path));
  const byPath = new Map<string, ReviewResult["file_reviews"][number]>();
  for (const review of reviews) {
    if (
      allowed.has(review.path) &&
      review.summary.trim() &&
      !byPath.has(review.path)
    ) {
      byPath.set(review.path, review);
    }
  }
  return batch.flatMap((file) => {
    const review = byPath.get(file.path);
    return review ? [review] : [];
  });
}

export function buildFileReviewNotes(
  reviews: ReviewResult["file_reviews"],
  verdicts: ReviewResult["prior_finding_verdicts"],
  priorFindings: PriorFindingContext[],
  issueCounts: Map<string, number>,
): Map<string, string> {
  const notes = new Map<string, string>();
  for (const review of reviews) {
    if (!notes.has(review.path)) {
      notes.set(review.path, flatten(review.summary));
    }
  }

  const priorById = new Map(
    priorFindings.map((finding) => [finding.id, finding]),
  );
  for (const verdict of verdicts) {
    const prior = priorById.get(verdict.id);
    if (!prior || verdict.status === "unknown") continue;
    const note = notes.get(prior.path) ?? "";
    const alreadyMentionsOutcome =
      verdict.status === "resolved"
        ? /\b(fix(?:ed)?|resolv(?:e|ed))\b/i.test(note)
        : /\b(open|remain(?:s|ed)?|unresolved)\b/i.test(note);
    if (alreadyMentionsOutcome) continue;

    const outcome =
      verdict.status === "resolved"
        ? `previous \`${prior.title}\` finding verified fixed (${flatten(verdict.reason)})`
        : `previous \`${prior.title}\` finding remains open (${flatten(verdict.reason)})`;
    notes.set(prior.path, note ? `${note}; ${outcome}` : outcome);
  }

  for (const [path, note] of notes) {
    if ((issueCounts.get(path) ?? 0) === 0 && !/^clean\b/i.test(note)) {
      notes.set(path, `clean; ${note}`);
    }
  }
  return notes;
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
export function advance(
  base: ReviewState,
  pr: PrDetails,
  usage: TokenUsage,
  counted: boolean,
  scope: ReviewState["scope"],
  advanceCheckpoint = true,
): ReviewState {
  return {
    ...base,
    lastReviewedSha: advanceCheckpoint ? pr.headSha : base.lastReviewedSha,
    summarySha: counted ? pr.headSha : base.summarySha,
    scope: counted ? scope : base.scope,
    reviewCount: base.reviewCount + (counted ? 1 : 0),
    usage: addUsage(base.usage, usage),
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
        usage: next.usage,
        commit: next.summarySha,
        scope: next.scope,
        history: next.history,
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

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cached: 0 };

function addUsage<T extends TokenUsage>(
  left: TokenUsage,
  right: T,
): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cached: left.cached + right.cached,
  };
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
