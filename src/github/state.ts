import { Octokit, Repo } from "./client";

/**
 * Persistent per-PR state lives inside a single hidden marker embedded in the
 * bot's walkthrough comment. GitHub Actions are stateless between runs, so this
 * marker is how we remember the last-reviewed SHA and drive incremental reviews.
 */
export interface ReviewState {
  lastReviewedSha: string | null;
  reviewCount: number;
  paused: boolean;
}

const MARKER = "AI-REVIEWER-STATE";
const MARKER_RE = /<!--\s*AI-REVIEWER-STATE\s+(\{.*?\})\s*-->/s;
export const WALKTHROUGH_MARKER = "<!-- AI-REVIEWER-WALKTHROUGH -->";

export const DEFAULT_STATE: ReviewState = {
  lastReviewedSha: null,
  reviewCount: 0,
  paused: false,
};

export function encodeState(state: ReviewState): string {
  return `<!-- ${MARKER} ${JSON.stringify(state)} -->`;
}

export function parseState(body: string | undefined): ReviewState | null {
  if (!body) return null;
  const m = body.match(MARKER_RE);
  if (!m) return null;
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(m[1]) };
  } catch {
    return null;
  }
}

/** Find the bot's walkthrough comment (the one carrying the state marker). */
export async function findWalkthroughComment(
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
      c.body?.includes(WALKTHROUGH_MARKER) || c.body?.includes(MARKER),
  );
  return found ? { id: found.id, body: found.body ?? "" } : null;
}

export async function readState(
  octokit: Octokit,
  repo: Repo,
  issue_number: number,
): Promise<ReviewState> {
  const comment = await findWalkthroughComment(octokit, repo, issue_number);
  return parseState(comment?.body) ?? { ...DEFAULT_STATE };
}

/**
 * Upsert the walkthrough comment, embedding the (possibly updated) state marker.
 * Passing `body: null` keeps the existing visible walkthrough and only updates state
 * (used by pause/resume).
 */
export async function writeWalkthrough(
  octokit: Octokit,
  repo: Repo,
  issue_number: number,
  body: string | null,
  state: ReviewState,
): Promise<void> {
  const existing = await findWalkthroughComment(octokit, repo, issue_number);
  const visible =
    body ?? stripMarkers(existing?.body ?? "") ?? "_No walkthrough yet._";
  const full = `${WALKTHROUGH_MARKER}\n${visible}\n\n${encodeState(state)}`;

  if (existing) {
    await octokit.rest.issues.updateComment({
      ...repo,
      comment_id: existing.id,
      body: full,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...repo,
      issue_number,
      body: full,
    });
  }
}

function stripMarkers(body: string): string {
  return body
    .replace(WALKTHROUGH_MARKER, "")
    .replace(MARKER_RE, "")
    .trim();
}
