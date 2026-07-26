import {
  FileKind,
  SEVERITIES,
  Severity,
  StoredFile,
  StoredFinding,
  StoredObservation,
} from "../types";

/**
 * Pure renderers for the sticky summary comment. Nothing here touches the
 * network, so the whole layout is unit-testable without an API key or a PR.
 */

export interface SummaryInput {
  findings: StoredFinding[];
  observations: StoredObservation[];
  files: StoredFile[];
  assessment: string;
  model: string;
  tokens: number;
}

export type SeverityCounts = Record<Severity, number>;

/** How aggressively the body was shrunk to fit GitHub's comment size cap. */
export type Degradation = "none" | "roster" | "observations" | "findings";

const DEGRADATIONS: Degradation[] = [
  "none",
  "roster",
  "observations",
  "findings",
];

const KIND_LABEL: Record<Exclude<FileKind, "code">, string> = {
  asset: "asset file",
  generated: "generated file",
  filtered: "excluded by path_filters",
  cap: "not reviewed (max_files)",
  binary: "binary file",
  deleted: "deleted",
};

export function countBySeverity(findings: StoredFinding[]): SeverityCounts {
  const counts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 } as SeverityCounts;
  for (const f of findings) counts[f.s]++;
  return counts;
}

export function renderStatusLine(counts: SeverityCounts): string {
  const total = counts.CRITICAL + counts.WARNING + counts.SUGGESTION;
  if (total === 0) {
    return "**Status:** No Issues Found | **Recommendation:** Approve";
  }
  const recommendation =
    counts.CRITICAL > 0
      ? "Do not merge — critical issues"
      : counts.WARNING > 0
        ? "Address before merge"
        : "Safe to merge — suggestions only";
  const noun = total === 1 ? "Issue" : "Issues";
  return `**Status:** ${total} ${noun} Found | **Recommendation:** ${recommendation}`;
}

export function renderOverviewTable(counts: SeverityCounts): string {
  return [
    "### Overview",
    "| Severity | Count |",
    "|----------|-------|",
    ...SEVERITIES.map((s) => `| ${s} | ${counts[s]} |`),
  ].join("\n");
}

/** Issue tables grouped CRITICAL → WARNING → SUGGESTION. Empty groups are omitted. */
export function renderIssueDetails(findings: StoredFinding[]): string {
  if (findings.length === 0) return "";

  const sections: string[] = [];
  for (const severity of SEVERITIES) {
    const group = findings.filter((f) => f.s === severity);
    if (group.length === 0) continue;
    sections.push(
      `#### ${severity}`,
      "| File | Line | Issue |",
      "|------|------|-------|",
      ...group.map((f) => `| \`${f.p}\` | ${f.l} | ${cell(f.t)} |`),
      "",
    );
  }

  return details("Issue Details (click to expand)", sections.join("\n").trim());
}

export function renderObservations(observations: StoredObservation[]): string {
  if (observations.length === 0) return "";
  return details(
    "Other Observations (not in diff)",
    [
      "| File | Line | Issue |",
      "|------|------|-------|",
      ...observations.map(
        (o) => `| \`${o.p}\` | ${o.l ?? "—"} | ${cell(o.n)} |`,
      ),
    ].join("\n"),
  );
}

export function renderFileRoster(files: StoredFile[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) => a.p.localeCompare(b.p));
  const noun = files.length === 1 ? "file" : "files";
  return details(
    `Files Reviewed (${files.length} ${noun})`,
    sorted.map((f) => `- \`${f.p}\` - ${fileLabel(f)}`).join("\n"),
  );
}

const ASSET_RE =
  /\.(png|jpe?g|gif|svg|webp|ico|ttf|otf|woff2?|mp3|mp4|wav|lottie)$/i;
const GENERATED_RE =
  /(\.g\.dart|\.freezed\.dart|\.pb\.go|\.generated\.[a-z]+|__generated__\/|\.min\.(js|css))$/i;

/**
 * Classify a file we *did* review but found nothing in, so the roster can say
 * "asset file" rather than a misleading "0 issues" for things nobody reviews.
 */
export function inferKind(path: string): "code" | "asset" | "generated" {
  if (GENERATED_RE.test(path)) return "generated";
  if (ASSET_RE.test(path)) return "asset";
  if (/(^|\/)assets\//i.test(path) && !/\.(dart|ts|tsx|js|jsx)$/i.test(path)) {
    return "asset";
  }
  return "code";
}

/**
 * Build the Files Reviewed roster for one run. A file that was dropped before
 * reaching the model is labelled with *why*; a reviewed file gets its issue
 * count, unless it's really an asset and the count would be noise.
 */
export function buildRoster(
  changedPaths: string[],
  droppedKinds: Map<string, FileKind>,
  issueCounts: Map<string, number>,
): StoredFile[] {
  const roster: StoredFile[] = [];
  for (const p of new Set(changedPaths)) {
    const dropped = droppedKinds.get(p);
    if (dropped) {
      roster.push({ p, k: dropped });
      continue;
    }
    const n = issueCounts.get(p) ?? 0;
    const inferred = inferKind(p);
    roster.push(
      n === 0 && inferred !== "code" ? { p, k: inferred } : { p, k: "code", n },
    );
  }
  return roster;
}

/**
 * Union the roster across runs: this run's classification wins for files it
 * touched, earlier runs supply the files it didn't. Counts are NOT merged here —
 * they're recomputed from the accumulated findings by `applyIssueCounts`, since
 * summing per-run counts would double-count a finding re-reported on a later push.
 */
export function mergeRoster(
  prev: StoredFile[],
  next: StoredFile[],
): StoredFile[] {
  const byPath = new Map(prev.map((f) => [f.p, f]));
  for (const f of next) byPath.set(f.p, f);
  return [...byPath.values()];
}

/** Recompute every `code` entry's issue count from the current finding set. */
export function applyIssueCounts(
  roster: StoredFile[],
  findings: StoredFinding[],
): StoredFile[] {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.p, (counts.get(f.p) ?? 0) + 1);
  return roster.map((f) => {
    const n = counts.get(f.p) ?? 0;
    // A file that has findings is code by definition, whatever we guessed before.
    if (n > 0) return { ...f, k: "code" as FileKind, n };
    return f.k === "code" ? { ...f, n: 0 } : f;
  });
}

export function fileLabel(f: StoredFile): string {
  if (f.k !== "code") return KIND_LABEL[f.k];
  const n = f.n ?? 0;
  return `${n} ${n === 1 ? "issue" : "issues"}`;
}

/**
 * Render the whole block, shrinking it if it would blow past `budget` chars.
 * Returns which degradation was applied so the caller can warn — we never
 * truncate silently.
 */
export function renderSummaryComment(
  input: SummaryInput,
  budget = Infinity,
): { body: string; degradation: Degradation; dropped: number } {
  let last = { body: "", degradation: "none" as Degradation, dropped: 0 };
  for (const degradation of DEGRADATIONS) {
    last = build(input, degradation);
    if (last.body.length <= budget) return last;
  }
  return last; // even the most degraded form is over budget — caller decides
}

function build(
  input: SummaryInput,
  degradation: Degradation,
): { body: string; degradation: Degradation; dropped: number } {
  const counts = countBySeverity(input.findings);
  let dropped = 0;

  const parts: string[] = [
    "## Code Review Summary",
    "",
    renderStatusLine(counts),
    "",
    renderOverviewTable(counts),
  ];

  let findings = input.findings;
  if (degradation === "findings" && findings.length > FINDINGS_CAP) {
    dropped = findings.length - FINDINGS_CAP;
    findings = findings.slice(0, FINDINGS_CAP);
  }
  const issues = renderIssueDetails(findings);
  if (issues) {
    parts.push("", issues);
    if (dropped > 0) parts.push("", `_…and ${dropped} more issue(s)._`);
  }

  let observations = input.observations;
  if (
    (degradation === "observations" || degradation === "findings") &&
    observations.length > OBSERVATIONS_CAP
  ) {
    const cut = observations.length - OBSERVATIONS_CAP;
    observations = observations.slice(0, OBSERVATIONS_CAP);
    dropped += cut;
  }
  const obs = renderObservations(observations);
  if (obs) parts.push("", obs);

  if (degradation === "none") {
    const roster = renderFileRoster(input.files);
    if (roster) parts.push("", roster);
  } else if (input.files.length > 0) {
    const noun = input.files.length === 1 ? "file" : "files";
    parts.push("", `_Reviewed ${input.files.length} ${noun}._`);
  }

  if (input.assessment.trim()) {
    parts.push("", "---", "", `**Overall Assessment:** ${input.assessment.trim()}`);
  }

  const credit = input.tokens > 0
    ? `Reviewed by ${input.model} · ${formatCount(input.tokens)} tokens`
    : `Reviewed by ${input.model}`;
  parts.push(
    "",
    "---",
    "<sub>`@bot review` · `@bot full review` · `@bot resolve` · `@bot help`</sub>",
    `<sub>${credit}</sub>`,
  );

  return { body: parts.join("\n"), degradation, dropped };
}

/** Locale-independent thousands separators, so snapshots don't depend on ICU. */
export function formatCount(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
}

const FINDINGS_CAP = 50;
const OBSERVATIONS_CAP = 20;

function details(summary: string, body: string): string {
  return `<details>\n<summary><b>${summary}</b></summary>\n\n${body}\n\n</details>`;
}

/** Markdown table cells can't contain pipes or newlines. */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}
