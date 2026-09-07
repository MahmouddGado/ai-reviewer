import {
  FileKind,
  ReviewScopeKind,
  ReviewSnapshot,
  SEVERITIES,
  Severity,
  StoredFile,
  StoredFinding,
  StoredObservation,
  TokenUsage,
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
  usage: TokenUsage;
  commit: string | null;
  scope: ReviewScopeKind;
  history: ReviewSnapshot[];
}

export type SeverityCounts = Record<Severity, number>;

/** How aggressively the body was shrunk to fit GitHub's comment size cap. */
export type Degradation =
  | "none"
  | "history"
  | "roster"
  | "observations"
  | "findings";

const DEGRADATIONS: Degradation[] = [
  "none",
  "history",
  "roster",
  "observations",
  "findings",
];

const KIND_LABEL: Record<Exclude<FileKind, "code">, string> = {
  asset: "asset file",
  generated: "generated file",
  filtered: "excluded by path_filters",
  cap: "not reviewed (max_files)",
  failed: "review failed (will retry)",
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
    return "**Status:** No Issues Found | **Recommendation:** Merge";
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

export function renderFileRoster(
  files: StoredFile[],
  context?: {
    commit: string | null;
    scope: ReviewScopeKind;
    total?: number;
  },
): string {
  const total = Math.max(files.length, context?.total ?? 0);
  if (total === 0) return "";
  const sorted = [...files].sort((a, b) => a.p.localeCompare(b.p));
  const noun = total === 1 ? "file" : "files";
  const pass =
    context?.scope === "incremental" && context.commit
      ? ` — incremental pass on ${context.commit.slice(0, 7)}`
      : "";
  return details(
    `Files Reviewed (${total} ${noun}${pass})`,
    [
      ...sorted.map((f) => `- \`${f.p}\` - ${fileLabel(f)}`),
      ...(total > files.length
        ? [`\n_…and ${total - files.length} more file(s)._`]
        : []),
    ].join("\n"),
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
  reviewNotes: Map<string, string> = new Map(),
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
      n === 0 && inferred !== "code"
        ? { p, k: inferred }
        : {
            p,
            k: "code",
            n,
            ...(n === 0 && reviewNotes.get(p)
              ? { r: rosterNote(reviewNotes.get(p)!) }
              : {}),
          },
    );
  }
  return roster;
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
  if (n === 0) return f.r || "clean";
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
    renderPassStatus(counts, input.files),
  ];
  if (input.findings.length > 0) {
    parts.push("", renderOverviewTable(counts));
  }

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

  if (degradation === "none" || degradation === "history") {
    const roster = renderFileRoster(input.files, {
      commit: input.commit,
      scope: input.scope,
    });
    if (roster) parts.push("", roster);
  } else if (input.files.length > 0) {
    const noun = input.files.length === 1 ? "file" : "files";
    parts.push("", `_Reviewed ${input.files.length} ${noun}._`);
  }

  if (input.scope === "full" && input.assessment.trim()) {
    parts.push("", "---", "", `**Overall Assessment:** ${input.assessment.trim()}`);
  }

  if (degradation === "none") {
    const history = renderHistory(input.history);
    if (history) parts.push("", history);
  } else if (input.history.length > 0) {
    dropped += input.history.length;
  }

  const credit = renderUsage(input.model, input.usage);
  parts.push(
    "",
    "---",
    "<!-- kilo-usage -->",
    `<sub>${credit}</sub>`,
  );

  return { body: parts.join("\n"), degradation, dropped };
}

export function renderHistory(history: ReviewSnapshot[]): string {
  if (history.length === 0) return "";
  const latest = history[0].sha.slice(0, 7);
  const noun = history.length === 1 ? "snapshot" : "snapshots";
  const lines = [
    "<!-- kilo-review-history -->",
    "<details>",
    `<summary><b>Previous Review Summaries</b> (${history.length} ${noun}, latest commit ${latest})</summary>`,
    "",
    "_Current summary above is authoritative. Previous snapshots are kept for context only._",
  ];

  for (const snapshot of history) {
    const counts = snapshot.counts ?? countBySeverity(snapshot.findings);
    const findingCount = Object.values(counts).reduce(
      (sum, count) => sum + count,
      0,
    );
    lines.push(
      "<!-- kilo-review-history-entry -->",
      `### Previous review (commit ${snapshot.sha.slice(0, 7)})`,
      "",
      renderPassStatus(counts, snapshot.files),
    );
    if (snapshot.findings.length > 0) {
      lines.push(
        "",
        renderOverviewTable(counts),
        "",
        renderIssueDetails(snapshot.findings),
      );
      if (findingCount > snapshot.findings.length) {
        lines.push(
          "",
          `_…and ${findingCount - snapshot.findings.length} more issue(s)._`,
        );
      }
    }
    const observations = renderObservations(snapshot.observations);
    if (observations) lines.push("", observations);
    const roster = renderFileRoster(snapshot.files, {
      commit: snapshot.sha,
      scope: snapshot.scope,
      total: snapshot.fileCount,
    });
    if (roster) lines.push("", roster);
    if (snapshot.scope === "full" && snapshot.assessment?.trim()) {
      lines.push("", `**Overall Assessment:** ${snapshot.assessment.trim()}`);
    }
    if (snapshot.model) {
      lines.push("", `<sub>${renderUsage(snapshot.model, snapshot.usage ?? { input: 0, output: 0, cached: 0 })}</sub>`);
    }
    lines.push("");
  }

  lines.push("</details>", "<!-- /kilo-review-history -->");
  return lines.join("\n");
}

function renderPassStatus(counts: SeverityCounts, files: StoredFile[]): string {
  if (files.some((file) => file.k === "failed" || file.k === "cap")) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return `**Status:** Review Incomplete (${total} issues found so far) | **Recommendation:** Complete review before merge`;
  }
  return renderStatusLine(counts);
}

export function renderUsage(model: string, usage: TokenUsage): string {
  if (usage.input + usage.output + usage.cached === 0) {
    return `Reviewed by ${model}`;
  }
  return [
    `Reviewed by ${model}`,
    `Input: ${formatCompactCount(usage.input)}`,
    `Output: ${formatCompactCount(usage.output)}`,
    `Cached: ${formatCompactCount(usage.cached)}`,
  ].join(" · ");
}

/** Locale-independent thousands separators, so snapshots don't depend on ICU. */
export function formatCount(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
}

/** Compact usage counts such as 29K, 7.3K, and 1.2M. */
export function formatCompactCount(n: number): string {
  const value = Math.max(0, n);
  if (value < 1000) return formatCount(value);
  const unit = value >= 1_000_000 ? "M" : "K";
  const divisor = unit === "M" ? 1_000_000 : 1000;
  const compact = Math.round((value / divisor) * 10) / 10;
  return `${compact}${unit}`;
}

const FINDINGS_CAP = 50;
const OBSERVATIONS_CAP = 20;

function details(summary: string, body: string): string {
  return `<details>\n<summary><b>${summary}</b></summary>\n\n${body}\n\n</details>`;
}

/** Markdown table cells can't contain pipes or newlines. */
function cell(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function rosterNote(text: string): string {
  const flat = cell(text);
  return flat.length <= 500 ? flat : `${flat.slice(0, 499).trimEnd()}…`;
}
