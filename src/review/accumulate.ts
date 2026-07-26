import {
  Finding,
  Observation,
  SEVERITIES,
  StoredFinding,
  StoredObservation,
} from "../types";
import { findingId, normalizeTitle } from "../github/review";

/**
 * Merging this run's results into the running per-PR totals.
 *
 * Everything here is pure so it can be tested without a PR: the only outside
 * input is `tracked`, a snapshot of what GitHub currently reports about the
 * comments we posted on earlier runs.
 */

/** What GitHub knows about a previously-posted comment. Mirrors `TrackedComment`. */
export interface CommentStatus {
  commentId: number;
  line: number;
  outdated: boolean;
}

/** Table cells only ever show one line; the full prose lives in the inline comment. */
const TEXT_CAP = 300;
const MAX_FINDINGS = 200;
const MAX_OBSERVATIONS = 50;

export function toStoredFinding(f: Finding): StoredFinding {
  return {
    id: findingId(f.path, f.title),
    p: f.path,
    l: f.line,
    s: f.severity,
    t: clamp(f.summary || f.title, TEXT_CAP),
  };
}

export function toStoredObservation(o: Observation): StoredObservation {
  return { p: o.path, ...(o.line ? { l: o.line } : {}), n: clamp(o.note, TEXT_CAP) };
}

/**
 * A finding the model anchored to a line that isn't in the diff. It's often a
 * real issue with a drifted line number, so it becomes an observation rather
 * than being thrown away — GitHub would reject it as an inline comment.
 */
export function findingToObservation(f: Finding): StoredObservation {
  return { p: f.path, l: f.line, n: clamp(f.summary || f.title, TEXT_CAP) };
}

/**
 * Carry findings forward across commits.
 *
 * A stored finding is dropped when GitHub reports its comment as outdated —
 * that means the author edited the code it was anchored to, so it counts as
 * addressed. Surviving findings have their line refreshed from GitHub, which is
 * what keeps the summary table accurate as later commits shift lines around.
 */
export function mergeFindings(
  prev: StoredFinding[],
  fresh: StoredFinding[],
  tracked: Map<string, CommentStatus>,
): { findings: StoredFinding[]; expired: StoredFinding[] } {
  const kept = new Map<string, StoredFinding>();
  const expired: StoredFinding[] = [];

  for (const f of prev) {
    const status = tracked.get(f.id);
    if (status?.outdated) {
      expired.push(f);
      continue;
    }
    kept.set(f.id, status ? { ...f, l: status.line, c: status.commentId } : f);
  }

  // Fresh results win — and re-add anything we just expired that is still real.
  for (const f of fresh) {
    const status = tracked.get(f.id);
    kept.set(f.id, status ? { ...f, l: status.line, c: status.commentId } : f);
  }

  return { findings: capFindings([...kept.values()]), expired };
}

/**
 * Observations have no review comment to track, so staleness can only be judged
 * at file granularity: if this run re-read the file and didn't repeat the note,
 * we drop it. That's the honest limit of what we can know here.
 */
export function mergeObservations(
  prev: StoredObservation[],
  fresh: StoredObservation[],
  reviewedPaths: Set<string>,
): StoredObservation[] {
  const byKey = new Map<string, StoredObservation>();
  for (const o of prev) {
    if (reviewedPaths.has(o.p)) continue;
    byKey.set(observationKey(o), o);
  }
  for (const o of fresh) byKey.set(observationKey(o), o);
  return [...byKey.values()].slice(0, MAX_OBSERVATIONS);
}

/** Don't repeat in "Other Observations" something already posted as an inline comment. */
export function dropObservationsWithComments(
  observations: StoredObservation[],
  findings: StoredFinding[],
): StoredObservation[] {
  const anchored = new Set(findings.map((f) => `${f.p}:${f.l}`));
  return observations.filter((o) => !anchored.has(`${o.p}:${o.l ?? ""}`));
}

export function observationKey(o: StoredObservation): string {
  return `${o.p}:${o.l ?? "-"}:${normalizeTitle(o.n).slice(0, 80)}`;
}

/**
 * Keep the state marker inside GitHub's comment-size cap. Severity order is the
 * eviction order, so a CRITICAL finding is never dropped to make room for a
 * SUGGESTION.
 */
export function capFindings(findings: StoredFinding[]): StoredFinding[] {
  if (findings.length <= MAX_FINDINGS) return findings;
  const ranked = [...findings].sort(
    (a, b) => SEVERITIES.indexOf(a.s) - SEVERITIES.indexOf(b.s),
  );
  return ranked.slice(0, MAX_FINDINGS);
}

function clamp(s: string, max: number): string {
  const flat = s.replace(/\s*\n\s*/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
