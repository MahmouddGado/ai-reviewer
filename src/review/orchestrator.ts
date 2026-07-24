import * as core from "@actions/core";
import { Octokit, Repo } from "../github/client";
import { Config, Finding, ReviewResult } from "../types";
import { parseDiffFiles } from "../github/diff";
import {
  ReviewState,
  readState,
  writeWalkthrough,
} from "../github/state";
import {
  buildInlineComments,
  existingCommentSignatures,
  postReview,
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

export interface RunOptions {
  forceFull: boolean; // full review vs incremental
  summaryOnly: boolean; // only regenerate the walkthrough
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
  const state = await readState(octokit, repo, pull_number);

  const scope = await resolveScope(octokit, repo, pr, state, opts.forceFull);
  if (!scope.hasChanges) {
    core.info("No reviewable changes in scope. Nothing to do.");
    await bumpState(octokit, repo, pr, state, null);
    return;
  }

  const allFiles = parseDiffFiles(scope.diffText);
  const { files, skippedByFilter, skippedByCap } = selectFiles(allFiles, config);
  if (files.length === 0) {
    core.info("All changed files were filtered out. Nothing to review.");
    await bumpState(octokit, repo, pr, state, null);
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
  let result: ReviewResult = await engine.review(system, user);

  if (config.verification && result.findings.length > 0) {
    core.info(`Verifying ${result.findings.length} finding(s)…`);
    try {
      result = await engine.verify(verificationPrompt(), user, result);
    } catch (err: any) {
      core.warning(`Verification pass failed (${err.message}); keeping draft.`);
    }
  }

  const existing =
    scope.kind === "incremental"
      ? await existingCommentSignatures(octokit, repo, pull_number)
      : new Set<string>();

  const { comments, skipped } = buildInlineComments(
    result.findings,
    files,
    existing,
  );

  const summary = renderSummary(result, scope.kind, {
    reviewed: files.length,
    findings: comments.length,
    skippedByFilter,
    skippedByCap,
    skippedUnanchored: skipped,
  });

  if (!opts.summaryOnly) {
    await postReview(octokit, repo, pull_number, pr.headSha, summary, comments);
  }

  const walkthrough = renderWalkthrough(result, scope.kind);
  await bumpState(octokit, repo, pr, state, walkthrough);

  core.info(
    `Done. Posted ${comments.length} inline comment(s); skipped ${skipped}.`,
  );
}

async function bumpState(
  octokit: Octokit,
  repo: Repo,
  pr: PrDetails,
  prev: ReviewState,
  walkthrough: string | null,
): Promise<void> {
  const next: ReviewState = {
    lastReviewedSha: pr.headSha,
    reviewCount: prev.reviewCount + (walkthrough ? 1 : 0),
    paused: prev.paused,
  };
  await writeWalkthrough(octokit, repo, pr.number, walkthrough, next);
}

interface Stats {
  reviewed: number;
  findings: number;
  skippedByFilter: number;
  skippedByCap: number;
  skippedUnanchored: number;
}

function renderSummary(
  result: ReviewResult,
  kind: "full" | "incremental",
  stats: Stats,
): string {
  const lines = [
    `**AI review (${kind})** — reviewed ${stats.reviewed} file(s), ${stats.findings} comment(s).`,
  ];
  if (stats.skippedByCap > 0) {
    lines.push(
      `> ⚠️ ${stats.skippedByCap} file(s) skipped (over \`max_files\`). Raise the limit or split the PR.`,
    );
  }
  const counts = countBySeverity(result.findings);
  if (stats.findings > 0) {
    lines.push(
      `\n${counts.potential_issue} potential issue(s) · ${counts.refactor} refactor(s) · ${counts.nitpick} nitpick(s).`,
    );
  } else {
    lines.push("\nNo blocking issues found. 🐰");
  }
  return lines.join("\n");
}

function renderWalkthrough(
  result: ReviewResult,
  kind: "full" | "incremental",
): string {
  const parts = [`## 🐰 AI Review — Walkthrough`, "", result.walkthrough];
  if (result.changed_files.length) {
    parts.push("\n### Changed files");
    parts.push("| File | Summary |", "| --- | --- |");
    for (const f of result.changed_files) {
      parts.push(`| \`${f.path}\` | ${f.summary.replace(/\|/g, "\\|")} |`);
    }
  }
  parts.push(
    `\n<sub>Last review: ${kind}. Push a commit for an incremental re-review, or comment \`@bot help\`.</sub>`,
  );
  return parts.join("\n");
}

function countBySeverity(findings: Finding[]) {
  return {
    potential_issue: findings.filter((f) => f.severity === "potential_issue")
      .length,
    refactor: findings.filter((f) => f.severity === "refactor").length,
    nitpick: findings.filter((f) => f.severity === "nitpick").length,
  };
}
