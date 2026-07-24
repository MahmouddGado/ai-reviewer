import { Config } from "../types";
import { DiffFile } from "../github/diff";

export interface PrMeta {
  title: string;
  description: string;
  linkedIssues: string;
  baseRef: string;
  headRef: string;
  incremental: boolean;
}

const PROFILE_GUIDANCE: Record<Config["profile"], string> = {
  quiet:
    "Only report genuine bugs, security issues, and correctness problems. Do NOT report style or nitpicks.",
  chill:
    "Report bugs, security, performance, and clear correctness issues. Include high-value refactors. Keep nitpicks rare.",
  assertive:
    "Report bugs, security, performance, correctness, refactors, and style nitpicks. Be thorough.",
};

export function buildSystemPrompt(config: Config): string {
  return [
    "You are a senior software engineer performing a rigorous but pragmatic code review of a pull request.",
    "Read the change the way its author would explain it, then find real problems.",
    "",
    "Rules:",
    "- ONLY comment on lines that appear in the provided diff. Each line is prefixed with its line number in the NEW file; use that exact number in `line`.",
    "- Every finding must explain WHY it matters, not just what it is.",
    "- Prefer a concrete `suggestion` (replacement code) whenever the fix is mechanical.",
    "- Severity: `potential_issue` = likely bug/security; `refactor` = risk/maintainability; `nitpick` = minor polish.",
    `- Profile: ${PROFILE_GUIDANCE[config.profile]}`,
    "- Do not invent issues. If the code is fine, return an empty findings array.",
    "- Write a clear `walkthrough` summarizing the PR, and one `changed_files` entry per meaningful file.",
    "",
    "Return your review by calling the `submit_review` tool. Do not write prose outside the tool call.",
  ].join("\n");
}

export function buildUserPrompt(
  meta: PrMeta,
  diffFiles: DiffFile[],
  config: Config,
): string {
  const parts: string[] = [];

  parts.push(
    `## Pull request${meta.incremental ? " (incremental — only new changes since last review are shown)" : ""}`,
  );
  parts.push(`**Title:** ${meta.title}`);
  parts.push(`**Branch:** ${meta.headRef} → ${meta.baseRef}`);
  if (meta.description.trim()) {
    parts.push(`\n**Description:**\n${truncate(meta.description, 4000)}`);
  }
  if (meta.linkedIssues.trim()) {
    parts.push(`\n**Linked issues:**\n${truncate(meta.linkedIssues, 3000)}`);
  }

  const relevant = pathInstructionsFor(diffFiles, config);
  if (relevant.length) {
    parts.push("\n## Path-specific instructions");
    for (const r of relevant) parts.push(`- \`${r.path}\`: ${r.instructions}`);
  }

  parts.push("\n## Diff");
  parts.push(
    "Lines are prefixed with their NEW-file line number. `+` = added, ` ` = context, `-` = removed (no new line number).",
  );
  for (const f of diffFiles) {
    parts.push(`\n### ${f.path}`);
    parts.push("```diff");
    parts.push(f.rendered);
    parts.push("```");
  }

  return parts.join("\n");
}

function pathInstructionsFor(diffFiles: DiffFile[], config: Config) {
  // Rendered globbing happens in the chunker; here we just surface matching rules.
  const { minimatch } = require("minimatch");
  return config.path_instructions.filter((pi) =>
    diffFiles.some((f) => minimatch(f.path, pi.path)),
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

export function verificationPrompt(): string {
  return [
    "You are verifying draft review findings to remove false positives.",
    "For each finding, decide if it is a real, actionable issue that is actually supported by the shown code and anchored to a changed line.",
    "Return the `submit_review` tool call again containing ONLY the findings that survive. Keep their fields intact. Drop anything speculative, duplicated, or not grounded in the diff.",
  ].join("\n");
}
