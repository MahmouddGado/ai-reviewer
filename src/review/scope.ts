import * as core from "@actions/core";
import { Octokit, Repo } from "../github/client";
import { getPrDiff, getRangeDiff } from "../github/diff";
import { ReviewState } from "../github/state";
import { PrDetails } from "./context";

export interface ReviewScope {
  kind: "full" | "incremental";
  base: string; // sha or ref to diff from
  head: string;
  diffText: string;
  hasChanges: boolean;
}

/**
 * Decide what to review and fetch the corresponding diff.
 *  - forceFull (opened/reopened/full-review command, or no prior state) → whole PR
 *  - otherwise                                                          → lastReviewedSha...head
 */
export async function resolveScope(
  octokit: Octokit,
  repo: Repo,
  pr: PrDetails,
  state: ReviewState,
  forceFull: boolean,
): Promise<ReviewScope> {
  if (!forceFull && state.lastReviewedSha === pr.headSha) {
    return { kind: state.scope, base: pr.headSha, head: pr.headSha, diffText: "", hasChanges: false };
  }
  const canIncrement =
    !forceFull &&
    state.lastReviewedSha &&
    state.lastReviewedSha !== pr.headSha;

  if (canIncrement) {
    try {
      const diffText = await getRangeDiff(
        octokit,
        repo,
        state.lastReviewedSha!,
        pr.headSha,
      );
      return {
        kind: "incremental",
        base: state.lastReviewedSha!,
        head: pr.headSha,
        diffText,
        hasChanges: diffText.trim().length > 0,
      };
    } catch (err: any) {
      // e.g. force-push made the old SHA unreachable → fall back to a full review.
      core.warning(
        `Incremental range unavailable (${err.message}); doing a full review.`,
      );
    }
  }

  const diffText = await getPrDiff(octokit, repo, pr.number);
  return {
    kind: "full",
    base: pr.baseSha,
    head: pr.headSha,
    diffText,
    hasChanges: diffText.trim().length > 0,
  };
}
