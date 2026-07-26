import * as core from "@actions/core";
import { createHash } from "crypto";
import { Octokit, Repo } from "./client";
import { DiffFile } from "./diff";
import { Finding } from "../types";

export interface InlineComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
}

/** What GitHub currently knows about a finding we posted on an earlier run. */
export interface TrackedComment {
  commentId: number;
  line: number;
  /** GitHub nulls `position` once the anchored code changes — i.e. the author touched it. */
  outdated: boolean;
}

export interface ExistingComments {
  byId: Map<string, TrackedComment>;
  /** `path:line:lowercased-title` signatures from comments written before air-ids existed. */
  legacy: Set<string>;
}

const AIR_ID_RE = /<!--\s*air-id:([0-9a-f]{8})\s*-->/;

/**
 * Stable identity for a finding, deliberately excluding the line number: the same
 * defect drifts down the file as commits land above it, and we still want to
 * recognise it as the same finding rather than post a duplicate.
 */
export function findingId(path: string, title: string): string {
  return createHash("sha1")
    .update(`${path}|${normalizeTitle(title)}`)
    .digest("hex")
    .slice(0, 8);
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").replace(/[.!?…]+$/, "").trim();
}

export function legacySignature(
  path: string,
  line: number,
  title: string,
): string {
  return `${path}:${line}:${normalizeTitle(title)}`;
}

/** Render a finding into a review-comment body, with a committable suggestion when present. */
export function renderFindingBody(f: Finding): string {
  let body = `**${f.severity}:** ${f.title}\n\n${f.body}`;
  if (f.suggestion && f.suggestion.trim().length > 0) {
    body += `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
  }
  return `${body}\n\n<!-- air-id:${findingId(f.path, f.title)} -->`;
}

/** Pull the air-id back out of a comment body we (or an earlier run) wrote. */
export function extractAirId(body: string): string | null {
  return body.match(AIR_ID_RE)?.[1] ?? null;
}

/**
 * Recover the title from a pre-air-id comment body. Handles both the original
 * CodeRabbit-style layout (title alone on a `**bold**` line) and the current
 * Kilo-style header (`**WARNING:** title`), so PRs reviewed by an older build
 * still dedup instead of getting every comment re-posted once.
 */
export function extractLegacyTitle(body: string): string | null {
  for (const l of body.split("\n")) {
    const kilo = l.match(/^\*\*(?:CRITICAL|WARNING|SUGGESTION):\*\*\s*(.+)$/);
    if (kilo) return kilo[1];
    const m = l.match(/^\*\*(.+?)\*\*$/);
    if (m && !/^(Potential issue|Refactor|Nitpick)/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Turn findings into GitHub inline comments.
 *
 * Three outcomes per finding:
 *  - `comments`   — anchors to a changed line and hasn't been posted before.
 *  - `duplicates` — already has a live comment; skipped so incremental runs
 *                   don't re-post the same note on every push.
 *  - `unanchored` — the model's line isn't commentable. GitHub would 422 on
 *                   these, but they're often real issues with a drifted line
 *                   number, so instead of discarding them we demote them to
 *                   "Other Observations" in the summary.
 */
export function buildInlineComments(
  findings: Finding[],
  diffFiles: DiffFile[],
  existing: ExistingComments,
): {
  comments: InlineComment[];
  unanchored: Finding[];
  duplicates: Finding[];
} {
  const byPath = new Map(diffFiles.map((f) => [f.path, f.commentableLines]));
  const comments: InlineComment[] = [];
  const unanchored: Finding[] = [];
  const duplicates: Finding[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const id = findingId(f.path, f.title);

    if (
      seen.has(id) ||
      existing.byId.has(id) ||
      existing.legacy.has(legacySignature(f.path, f.line, f.title))
    ) {
      duplicates.push(f);
      continue;
    }

    const commentable = byPath.get(f.path);
    if (!commentable || !commentable.has(f.line)) {
      unanchored.push(f);
      continue;
    }

    seen.add(id);
    const comment: InlineComment = {
      path: f.path,
      body: renderFindingBody(f),
      line: f.line,
      side: "RIGHT",
    };

    if (f.end_line && f.end_line > f.line && commentable.has(f.end_line)) {
      comment.start_line = f.line;
      comment.start_side = "RIGHT";
      comment.line = f.end_line; // GitHub: `line` is the LAST line of the range
    }

    comments.push(comment);
  }

  return { comments, unanchored, duplicates };
}

/**
 * Read back every review comment we've posted on this PR. This is both the dedup
 * source and — via `outdated` — the signal that the author has changed the code a
 * finding was anchored to, which is how findings drop off the summary once fixed.
 */
export async function readExistingComments(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
): Promise<ExistingComments> {
  const byId = new Map<string, TrackedComment>();
  const legacy = new Set<string>();

  try {
    const comments = await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      { ...repo, pull_number, per_page: 100 },
    );
    for (const c of comments) {
      const body = c.body ?? "";
      const line = c.line ?? c.original_line;
      if (!c.path || !line) continue;

      const id = extractAirId(body);
      if (id) {
        byId.set(id, {
          commentId: c.id,
          line,
          outdated: c.position === null || c.position === undefined,
        });
        continue;
      }
      const title = extractLegacyTitle(body);
      if (title) legacy.add(legacySignature(c.path, line, title));
    }
  } catch (err: any) {
    core.warning(`Could not list existing review comments: ${err.message}`);
  }

  return { byId, legacy };
}

/**
 * Post the review. GitHub rejects the whole review if any single comment targets
 * an invalid line, so we pre-filter to commentable lines and fall back to posting
 * comments one-by-one if the batch call still fails.
 *
 * With no comments to post there is nothing to say here — the sticky summary
 * comment carries the whole report — so we skip creating an empty review object
 * rather than adding one to the timeline on every push.
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
    core.info("No new inline comments; skipping review creation.");
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
