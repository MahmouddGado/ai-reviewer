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
    "Report CRITICAL and WARNING only. Do not report SUGGESTION findings at all.",
  chill:
    "Report CRITICAL and WARNING thoroughly. Keep SUGGESTION findings rare — only when the payoff is obvious.",
  assertive:
    "Report all three levels, including SUGGESTION. Be thorough.",
};

/**
 * The one-shot exemplar below matters more than any rule in this prompt: it is
 * what actually moves a model from "Consider adding error handling here." to a
 * body that traces a concrete failure path.
 */
const BODY_EXEMPLAR = [
  "Example of the required body quality:",
  "",
  "> `confirmReview` catches `on AppFailure` and `catch (e, st)` but does not handle",
  "> `on SessionExpiredException` explicitly — unlike `fetchSalesData`, `updateRecord`, and",
  "> `deleteRecord` in this same provider. A `SessionExpiredException` will fall through to the",
  "> generic `catch (e, st)`, get passed to `showFromException` (which silently returns for session",
  "> expiry), then `rethrow` propagates it to the caller's `catch (_)` which swallows it. This",
  "> breaks the consistent error-handling pattern used elsewhere.",
  "",
  "Unacceptable, for contrast: \"Consider adding error handling here.\" — it names nothing, traces",
  "nothing, and could have been written without reading the code.",
].join("\n");

export function buildSystemPrompt(config: Config): string {
  return [
    "You are a senior software engineer performing a rigorous but pragmatic code review of a pull request.",
    "Read the change the way its author would explain it, then find real problems.",
    "",
    "## Severity",
    "- `CRITICAL` — the change causes incorrect behaviour, data loss, a security hole, a crash, or breaks a documented contract, on a path that will actually be taken. Merging is unsafe.",
    "- `WARNING` — a real defect or risk under a plausible condition: an unhandled error path, a race, a resource leak, a performance cliff, or an inconsistency with the pattern the rest of the file follows. Should be fixed before merge.",
    "- `SUGGESTION` — no correctness impact: naming, redundancy, dead code, clearer structure, missing coverage.",
    "If you cannot name the concrete input or state that triggers the problem, it is at most a `SUGGESTION`.",
    `Profile: ${PROFILE_GUIDANCE[config.profile]}`,
    "",
    "## Where a finding may point",
    "- A `finding` MUST anchor to a line shown in the diff. Each diff line is prefixed with its line number in the NEW file — use that exact number in `line`.",
    "- If you notice a real problem in code you can see but that is NOT a changed line, put it in `observations` instead. Do not force it into `findings` with an approximate line number.",
    "",
    "## Writing a finding",
    "- `title`: a specific noun phrase naming the defect, at most ~8 words, no trailing period, no severity prefix. It renders directly after `**WARNING:**`.",
    "- `summary`: ONE line giving the problem and its consequence. It renders inside a markdown table cell, so no newlines and no `|`.",
    "- `body`: 3–6 sentences, one paragraph, no bullets and no headings. Name every symbol involved in backticks — function, class, variable, exception type, field. Trace the concrete failure path in order: which call leads to which state leads to which consequence. When the file already has an established pattern for this case, name the specific siblings that follow it. End with the user-visible or data-visible consequence. Never restate the title and never give generic advice.",
    "- `suggestion`: include ONLY when the fix is a mechanical whole-line replacement of exactly the lines `[line..end_line]`. Give the replacement lines alone, no fences. A wrong suggestion is worse than none — omit it when unsure.",
    "",
    BODY_EXEMPLAR,
    "",
    "## Also required",
    "- `overall_assessment`: 2–5 sentences judging the change as a whole — name the patterns it introduces, say whether the design is sound, and end by characterising what the issues amount to. Do not re-enumerate the individual findings.",
    "- Do not invent issues. If the code is fine, return an empty `findings` array and say so in the assessment.",
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
    "Return the `submit_review` tool call again containing ONLY the findings that survive. Drop anything speculative, duplicated, or not grounded in the diff.",
    "Keep the surviving findings' fields intact, and re-check each `body` against the quality contract — if a body is thin or generic, rewrite it to name the symbols and trace the failure path rather than dropping the finding.",
    "Preserve `overall_assessment` and `observations` unchanged unless a finding you dropped was also wrong there.",
  ].join("\n");
}
