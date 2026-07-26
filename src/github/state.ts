import * as core from "@actions/core";
import { gunzipSync, gzipSync } from "zlib";
import { Octokit, Repo } from "./client";
import { StoredFile, StoredFinding, StoredObservation } from "../types";

/**
 * Persistent per-PR state lives inside a single hidden marker embedded in the
 * bot's sticky summary comment. GitHub Actions are stateless between runs, so
 * this marker is how we remember the last-reviewed SHA and — since v2 — the
 * accumulated findings that make the summary describe the whole PR rather than
 * just the newest commit.
 */
export interface ReviewState {
  v: number;
  lastReviewedSha: string | null;
  reviewCount: number;
  paused: boolean;
  /** Cumulative input+output tokens across every run on this PR. */
  tokens: number;
  model: string;
  assessment: string;
  findings: StoredFinding[];
  observations: StoredObservation[];
  files: StoredFile[];
}

export const STATE_VERSION = 2;

/** GitHub's hard cap on an issue-comment body. */
export const COMMENT_LIMIT = 65536;
/** Headroom for the markers, separators, and any server-side normalisation. */
const SLACK = 2048;

export const SUMMARY_MARKER = "<!-- kilo-review -->";
const STATE_RE = /<!--\s*AI-REVIEW-STATE\s+v2\s+([A-Za-z0-9+/=]+)\s*-->/;

/* Markers written by earlier builds. We still *match* them so an open PR keeps
 * updating its original comment instead of sprouting a second one, but we only
 * ever *write* SUMMARY_MARKER + the v2 state marker. */
const LEGACY_WALKTHROUGH_MARKER = "<!-- AI-REVIEWER-WALKTHROUGH -->";
const LEGACY_STATE_RE = /<!--\s*AI-REVIEWER-STATE\s+(\{.*?\})\s*-->/s;

export const DEFAULT_STATE: ReviewState = {
  v: STATE_VERSION,
  lastReviewedSha: null,
  reviewCount: 0,
  paused: false,
  tokens: 0,
  model: "",
  assessment: "",
  findings: [],
  observations: [],
  files: [],
};

/**
 * The payload is gzipped and base64'd rather than embedded as raw JSON. Findings
 * quote real code, and a title containing `-->` would otherwise close the HTML
 * comment early — corrupting the visible summary and leaking JSON into the page.
 * Compression is a useful side effect: this data is highly repetitive.
 */
export function encodeState(state: ReviewState): string {
  const packed = gzipSync(Buffer.from(JSON.stringify(state), "utf8")).toString(
    "base64",
  );
  return `<!-- AI-REVIEW-STATE v2 ${packed} -->`;
}

export function parseState(body: string | undefined): ReviewState | null {
  if (!body) return null;

  const v2 = body.match(STATE_RE);
  if (v2) {
    try {
      const json = gunzipSync(Buffer.from(v2[1], "base64")).toString("utf8");
      return { ...DEFAULT_STATE, ...JSON.parse(json) };
    } catch (err: any) {
      core.warning(`Could not decode review state: ${err.message}`);
      return null;
    }
  }

  // v1: raw JSON with only lastReviewedSha/reviewCount/paused. Migrate so the PR
  // keeps its incremental position instead of being reviewed from scratch.
  const v1 = body.match(LEGACY_STATE_RE);
  if (v1) {
    try {
      const legacy = JSON.parse(v1[1]);
      core.info("Migrating v1 review state to v2.");
      return { ...DEFAULT_STATE, ...legacy, v: STATE_VERSION };
    } catch {
      return null;
    }
  }

  return null;
}

/** Find the bot's sticky summary comment, across every marker we've ever written. */
export async function findSummaryComment(
  octokit: Octokit,
  repo: Repo,
  issue_number: number,
): Promise<{ id: number; body: string } | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number,
    per_page: 100,
  });
  const found = comments.find(
    (c) =>
      c.body?.includes(SUMMARY_MARKER) ||
      c.body?.includes("AI-REVIEW-STATE") ||
      c.body?.includes(LEGACY_WALKTHROUGH_MARKER) ||
      c.body?.includes("AI-REVIEWER-STATE"),
  );
  return found ? { id: found.id, body: found.body ?? "" } : null;
}

export async function readState(
  octokit: Octokit,
  repo: Repo,
  issue_number: number,
): Promise<ReviewState> {
  const comment = await findSummaryComment(octokit, repo, issue_number);
  return parseState(comment?.body) ?? { ...DEFAULT_STATE };
}

/**
 * Upsert the sticky summary comment.
 *
 * `render` is called with the number of characters actually available once the
 * encoded state is accounted for, so the renderer can shrink its optional
 * sections rather than have the whole write rejected by GitHub.
 */
export async function writeSummary(
  octokit: Octokit,
  repo: Repo,
  issue_number: number,
  state: ReviewState,
  render: (budget: number) => string,
): Promise<void> {
  const marker = encodeState(state);
  const budget = COMMENT_LIMIT - marker.length - SUMMARY_MARKER.length - SLACK;
  let visible = render(Math.max(budget, 1000));

  const full = `${SUMMARY_MARKER}\n${visible}\n\n${marker}`;
  if (full.length > COMMENT_LIMIT) {
    core.warning(
      `Summary comment is ${full.length} chars, over GitHub's ${COMMENT_LIMIT} limit; hard-trimming.`,
    );
    visible = visible.slice(0, Math.max(budget, 1000));
  }

  const body = `${SUMMARY_MARKER}\n${visible}\n\n${marker}`;
  const existing = await findSummaryComment(octokit, repo, issue_number);

  if (existing) {
    await octokit.rest.issues.updateComment({
      ...repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({ ...repo, issue_number, body });
  }
}
