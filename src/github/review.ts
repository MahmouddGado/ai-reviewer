import * as core from "@actions/core";
import { Octokit, Repo } from "./client";
import { DiffFile } from "./diff";
import { Finding } from "../types";

const SEVERITY_META: Record<
  Finding["severity"],
  { emoji: string; label: string }
> = {
  potential_issue: { emoji: "⛔", label: "Potential issue" },
  refactor: { emoji: "⚠️", label: "Refactor" },
  nitpick: { emoji: "🔹", label: "Nitpick" },
};

export interface InlineComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
}

/** Render a finding into a review-comment body, with a committable suggestion when present. */
export function renderFindingBody(f: Finding): string {
  const { emoji, label } = SEVERITY_META[f.severity];
  let body = `${emoji} **${label}** · _${f.category}_\n\n**${f.title}**\n\n${f.body}`;
  if (f.suggestion && f.suggestion.trim().length > 0) {
    body += `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
  }
  return body;
}

/**
 * Turn findings into GitHub inline comments, dropping any that don't anchor to a
 * commentable line (prevents 422s) and any that duplicate an existing bot comment
 * (prevents re-posting the same nit on every incremental run).
 */
export function buildInlineComments(
  findings: Finding[],
  diffFiles: DiffFile[],
  existingSignatures: Set<string>,
): { comments: InlineComment[]; skipped: number } {
  const byPath = new Map(diffFiles.map((f) => [f.path, f.commentableLines]));
  const comments: InlineComment[] = [];
  let skipped = 0;

  for (const f of findings) {
    const commentable = byPath.get(f.path);
    if (!commentable || !commentable.has(f.line)) {
      skipped++;
      continue;
    }
    if (existingSignatures.has(signature(f.path, f.line, f.title))) {
      skipped++;
      continue;
    }

    const comment: InlineComment = {
      path: f.path,
      body: renderFindingBody(f),
      line: f.line,
      side: "RIGHT",
    };

    if (
      f.end_line &&
      f.end_line > f.line &&
      commentable.has(f.end_line)
    ) {
      comment.start_line = f.line;
      comment.start_side = "RIGHT";
      comment.line = f.end_line; // GitHub: `line` is the LAST line of the range
    }

    comments.push(comment);
  }

  return { comments, skipped };
}

export function signature(path: string, line: number, title: string): string {
  return `${path}:${line}:${title.trim().toLowerCase()}`;
}

/** Collect signatures of existing bot review comments so we can dedup. */
export async function existingCommentSignatures(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
): Promise<Set<string>> {
  const sigs = new Set<string>();
  try {
    const comments = await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      { ...repo, pull_number, per_page: 100 },
    );
    for (const c of comments) {
      const line = c.line ?? c.original_line;
      const title = extractTitle(c.body ?? "");
      if (c.path && line && title) {
        sigs.add(signature(c.path, line, title));
      }
    }
  } catch (err: any) {
    core.warning(`Could not list existing review comments: ${err.message}`);
  }
  return sigs;
}

/** Titles are rendered as **bold** on their own line — pull the first one back out. */
function extractTitle(body: string): string | null {
  const lines = body.split("\n");
  for (const l of lines) {
    const m = l.match(/^\*\*(.+?)\*\*$/);
    if (m && !/^(Potential issue|Refactor|Nitpick)/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Post the review. GitHub rejects the whole review if any single comment targets
 * an invalid line, so we submit comments individually-tolerant by pre-filtering,
 * and fall back to posting comments one-by-one if the batch call still fails.
 */
export async function postReview(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
  commitId: string,
  summaryBody: string,
  comments: InlineComment[],
): Promise<void> {
  if (comments.length === 0) {
    await octokit.rest.pulls.createReview({
      ...repo,
      pull_number,
      commit_id: commitId,
      body: summaryBody,
      event: "COMMENT",
    });
    return;
  }

  try {
    await octokit.rest.pulls.createReview({
      ...repo,
      pull_number,
      commit_id: commitId,
      body: summaryBody,
      event: "COMMENT",
      comments: comments.map((c) => ({
        path: c.path,
        body: c.body,
        line: c.line,
        side: c.side,
        ...(c.start_line
          ? { start_line: c.start_line, start_side: c.start_side }
          : {}),
      })),
    });
  } catch (err: any) {
    core.warning(
      `Batch review failed (${err.message}); posting comments individually.`,
    );
    await octokit.rest.pulls.createReview({
      ...repo,
      pull_number,
      commit_id: commitId,
      body: summaryBody,
      event: "COMMENT",
    });
    for (const c of comments) {
      try {
        await octokit.rest.pulls.createReviewComment({
          ...repo,
          pull_number,
          commit_id: commitId,
          path: c.path,
          body: c.body,
          line: c.line,
          side: c.side,
          ...(c.start_line
            ? { start_line: c.start_line, start_side: c.start_side }
            : {}),
        });
      } catch (e: any) {
        core.warning(`Skipped comment on ${c.path}:${c.line} — ${e.message}`);
      }
    }
  }
}

/** Simple issue-level comment (used for command replies and errors). */
export async function postIssueComment(
  octokit: Octokit,
  repo: Repo,
  issue_number: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({ ...repo, issue_number, body });
}
