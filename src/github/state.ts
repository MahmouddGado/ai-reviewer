import * as core from "@actions/core";
import { gunzipSync, gzipSync } from "zlib";
import { Octokit, Repo } from "./client";
import {
  ReviewScopeKind,
  ReviewSnapshot,
  StoredFile,
  StoredFinding,
  StoredObservation,
  TokenUsage,
} from "../types";

/**
 * Persistent per-PR state lives inside a single hidden marker embedded in the
 * bot's sticky summary comment. GitHub Actions are stateless between runs, so
 * this marker remembers the last completed SHA, the current independent review,
 * and bounded prior-summary snapshots. Older cumulative states remain readable.
 */
export interface ReviewState {
  v: number;
  lastReviewedSha: string | null;
  /** Commit represented by the visible current summary (normally the head SHA). */
  summarySha: string | null;
  reviewCount: number;
  paused: boolean;
  /** Input, output, and cache-token usage for the current review. */
  usage: TokenUsage;
  model: string;
  assessment: string;
  scope: ReviewScopeKind;
  findings: StoredFinding[];
  observations: StoredObservation[];
  /** Files and outcomes from the current pass, not the cumulative PR roster. */
  files: StoredFile[];
  history: ReviewSnapshot[];
}

export const STATE_VERSION = 3;
export const HISTORY_LIMIT = 3;

/** GitHub's hard cap on an issue-comment body. */
export const COMMENT_LIMIT = 65536;
/** Headroom for the markers, separators, and any server-side normalisation. */
const SLACK = 2048;

export const SUMMARY_MARKER = "<!-- kilo-review -->";
const STATE_RE = /<!--\s*AI-REVIEW-STATE\s+v3\s+([A-Za-z0-9+/=]+)\s*-->/;
const V2_STATE_RE = /<!--\s*AI-REVIEW-STATE\s+v2\s+([A-Za-z0-9+/=]+)\s*-->/;

/* Markers written by earlier builds. We still *match* them so an open PR keeps
 * updating its original comment instead of sprouting a second one, but we only
 * ever *write* SUMMARY_MARKER + the latest state marker. */
const LEGACY_WALKTHROUGH_MARKER = "<!-- AI-REVIEWER-WALKTHROUGH -->";
const LEGACY_STATE_RE = /<!--\s*AI-REVIEWER-STATE\s+(\{.*?\})\s*-->/s;

export const DEFAULT_STATE: ReviewState = {
  v: STATE_VERSION,
  lastReviewedSha: null,
  summarySha: null,
  reviewCount: 0,
  paused: false,
  usage: { input: 0, output: 0, cached: 0 },
  model: "",
  assessment: "",
  scope: "full",
  findings: [],
  observations: [],
  files: [],
  history: [],
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
  return `<!-- AI-REVIEW-STATE v3 ${packed} -->`;
}

export function parseState(body: string | undefined): ReviewState | null {
  if (!body) return null;

  const current = body.match(STATE_RE);
  if (current) {
    try {
      const json = gunzipSync(Buffer.from(current[1], "base64")).toString("utf8");
      return migrateState(JSON.parse(json));
    } catch (err: any) {
      core.warning(`Could not decode review state: ${err.message}`);
      return null;
    }
  }

  const v2 = body.match(V2_STATE_RE);
  if (v2) {
    try {
      const json = gunzipSync(Buffer.from(v2[1], "base64")).toString("utf8");
      core.info("Migrating v2 review state to v3.");
      return migrateState(JSON.parse(json));
    } catch (err: any) {
      core.warning(`Could not decode v2 review state: ${err.message}`);
      return null;
    }
  }

  // v1: raw JSON with only lastReviewedSha/reviewCount/paused. Migrate so the PR
  // keeps its incremental position instead of being reviewed from scratch.
  const v1 = body.match(LEGACY_STATE_RE);
  if (v1) {
    try {
      const legacy = JSON.parse(v1[1]);
      core.info("Migrating v1 review state to v3.");
      return migrateState(legacy);
    } catch {
      return null;
    }
  }

  return null;
}

/** Add the currently-visible summary to the bounded history for the next pass. */
export function historyWithPrevious(state: ReviewState): ReviewSnapshot[] {
  const sha = state.summarySha ?? state.lastReviewedSha;
  if (!sha || state.reviewCount === 0) return state.history;

  const snapshot: ReviewSnapshot = {
    sha,
    assessment: state.assessment,
    model: state.model,
    usage: { ...state.usage },
    scope: state.scope,
    counts: {
      CRITICAL: state.findings.filter((finding) => finding.s === "CRITICAL")
        .length,
      WARNING: state.findings.filter((finding) => finding.s === "WARNING")
        .length,
      SUGGESTION: state.findings.filter((finding) => finding.s === "SUGGESTION")
        .length,
    },
    findings: state.findings.map((finding) => ({ ...finding })),
    observations: state.observations.map((note) => ({ ...note })),
    fileCount: state.files.length,
    files: state.files.map((file) => ({ ...file })),
  };
  return [snapshot, ...state.history].slice(
    0,
    HISTORY_LIMIT,
  );
}

function migrateState(raw: any): ReviewState {
  const legacyTokens = finite(raw?.tokens);
  const usage: TokenUsage = raw?.usage
    ? {
        input: finite(raw.usage.input),
        output: finite(raw.usage.output),
        cached: finite(raw.usage.cached),
      }
    : { input: legacyTokens, output: 0, cached: 0 };

  return {
    ...DEFAULT_STATE,
    v: STATE_VERSION,
    lastReviewedSha:
      typeof raw?.lastReviewedSha === "string" ? raw.lastReviewedSha : null,
    summarySha:
      typeof raw?.summarySha === "string"
        ? raw.summarySha
        : typeof raw?.lastReviewedSha === "string"
          ? raw.lastReviewedSha
          : null,
    usage,
    reviewCount: Math.max(0, Math.trunc(finite(raw?.reviewCount))),
    paused: raw?.paused === true,
    model: typeof raw?.model === "string" ? raw.model : "",
    assessment: typeof raw?.assessment === "string" ? raw.assessment : "",
    scope: raw?.scope === "incremental" ? "incremental" : "full",
    findings: Array.isArray(raw?.findings) ? raw.findings : [],
    observations: Array.isArray(raw?.observations) ? raw.observations : [],
    files: Array.isArray(raw?.files) ? raw.files : [],
    history: Array.isArray(raw?.history)
      ? raw.history.slice(0, HISTORY_LIMIT)
      : [],
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
