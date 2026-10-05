# How the ai-reviewer harness works

Reference for the `ai-code-review` skill. Each section names the Action source it mirrors
and the `air.mjs` function that ports it.

## 1. Pipeline

```
trigger (routine / manual) ─► locate ─► diff ─► prepare ─► review ─► verify ─► finalize ─► publish
                              state     git/API  batches    Claude    Claude    pure        GitHub
```

| Step | Action source | air.mjs |
|---|---|---|
| Gates: auto_review, drafts, base branches, title keywords, paused | `src/main.ts` `onPullRequest` | `cmdLocate --auto` |
| Scope: full vs `lastReviewedSha...head` | `src/review/scope.ts` | `cmdLocate` |
| Diff → numbered lines + commentable set | `src/github/diff.ts` | `parseDiffFiles` |
| File selection with a drop reason | `src/review/chunker.ts` | `selectFiles` |
| Chunking at hunk → line boundaries | `src/review/batch.ts` | `planBatches`, `splitFile` |
| Prompts | `src/review/prompts.ts` | `references/review-prompt.md`, `buildUserPrompt` |
| Model review + verification | `src/review/engine.ts` | **you** (draft/result JSON) |
| Salvage invalid output | `engine.ts` `salvage` | `sanitizeResult` |
| Merge batches, reconcile verdicts | `orchestrator.ts` `mergeResults` | `mergeResults` |
| Inline comments + dedup | `src/github/review.ts` | `buildInlineComments` |
| Stored findings/observations | `src/review/accumulate.ts` | `toStoredFinding`, `dedupeObservations` |
| Roster + per-file notes | `render.ts` `buildRoster`, `orchestrator.ts` `buildFileReviewNotes` | same names |
| Summary markdown | `src/review/render.ts` | `renderSummaryComment` |
| State marker + history | `src/github/state.ts` | `encodeState`, `historyWithPrevious`, `composeStickyBody` |

## 2. Scope and checkpoints

- `lastReviewedSha` is the last commit whose pass **completed** (no failed/incomplete batch).
- `opened`/no state/`--full` → full PR diff (`base...head`). Otherwise the incremental range
  `lastReviewedSha...head`. Same head already reviewed → nothing to do.
- A failed batch still publishes (its files show `review failed (will retry)`, status becomes
  "Review Incomplete") but the checkpoint does not move, so the next run retries.
- Unreachable base (force-push) → full review.

## 3. The diff the model sees

```
@@ -10,6 +10,8 @@ export function f() {
   10   const a = 1;
   11 + const b = compute(a);
      - const old = 2;
   12   return a;
```

Five-wide NEW-file line number, then `+` added / space context / `-` removed (no number).
Only `+` and context lines are **commentable**; GitHub rejects anything else with a 422.
A finding on a non-commentable line is not dropped — it is demoted to "Other Observations".

## 4. File selection (drop reasons shown in the roster)

`deleted` → `binary` (no commentable lines) → `generated` (lock files, `*.min.js`, `*.map`,
`dist/`, `build/`, `__generated__/`, `*.snap`, unless `review_generated`) → `filtered`
(`path_filters`: `!glob` excludes, plain globs are an allow-list) → largest-first →
`cap` (beyond `max_files`; 0 = unlimited).

## 5. Chunking

`batch_chars` (default 200 000) bounds each request. Cost per file = rendered diff + path +
128. Oversized files split at `@@` hunks, then lines, then hard-split very long lines; parts
are labelled `Part i/n` and carry only the commentable lines visible in that part.

## 6. Review contract (what you return per batch)

`overall_assessment`, `findings[]` (path, line, end_line?, severity, category, title, summary,
body, suggestion?), `observations[]`, `file_reviews[]` (one per file, `clean; <evidence>` when
no finding), `prior_finding_verdicts[]` (one per supplied prior id). See
`result-schema.json`. Severity: CRITICAL = merging unsafe on a real path; WARNING = real
defect under a plausible condition; SUGGESTION = no correctness impact. Profiles: quiet
(no SUGGESTION), chill (rare SUGGESTION), assertive (all).

The verifier receives the same material plus the draft and may only drop, downgrade, remove
unsafe suggestions, or tighten prose. If it returns an empty `observations`/`file_reviews`/
`prior_finding_verdicts` or assessment, the draft's value is kept.

## 7. Identity, dedup, and refresh

- Finding id = `sha1(path + "|" + normalizedTitle)[:8]` — **no line number**, so a finding that
  drifts down the file keeps its identity. Every inline body ends `<!-- air-id:<id> -->`.
- Before posting: same id with a **live** comment → duplicate, skipped. Same id with only an
  **outdated** comment (anchor changed) → posted again on the new commit ("refresh").
  Legacy comments without an air-id are matched by `path:line:title`.
- Incremental runs give prior findings (for files in the batch) to the model; it answers
  `resolved` / `unresolved` / `unknown`. A re-reported prior finding with the same title is
  aliased to the prior id so it does not double-post. Verdicts become roster notes
  ("previous `X` finding verified fixed (…)" / "remains open (…)"). Only findings reported in
  *this* pass count toward the totals — nothing is carried over silently.

## 8. The sticky summary

```
<!-- kilo-review -->
## Code Review Summary

**Status:** 2 Issues Found | **Recommendation:** Address before merge
### Overview            (severity count table, only when there are findings)
<details> Issue Details (click to expand)     #### CRITICAL / WARNING / SUGGESTION tables
<details> Other Observations (not in diff)
<details> Files Reviewed (N files — incremental pass on abc1234)   - `path` - 1 issue | clean; … | generated file | …
---
**Overall Assessment:** …                     (full-scope passes only)
<details> Previous Review Summaries (≤3 snapshots, newest first)
---
<sub>Reviewed by <model> · Input · Output · Cached</sub>   (token counts only when known)

<!-- AI-REVIEW-STATE v3 <base64(gzip(JSON))> -->
```

Status rules: no findings → "No Issues Found | Merge"; any CRITICAL → "Do not merge —
critical issues"; any WARNING → "Address before merge"; suggestions only → "Safe to merge —
suggestions only"; any `failed`/`cap` file → "Review Incomplete (n issues found so far) |
Complete review before merge".

Size: GitHub caps a comment at 65 536 chars. The renderer degrades in order — drop history →
collapse roster to a count → cap observations at 20 → cap findings at 50 — and reports it.

## 9. State (v3)

`{v, lastReviewedSha, summarySha, reviewCount, paused, usage, model, assessment, scope,
findings[{id,p,l,s,h,t,c}], observations[{p,l,n}], files[{p,k,n,r}], history[≤3 snapshots]}`
— short keys because it lives inside the comment. gzip+base64 so code containing `-->`
cannot break the HTML comment. v1/v2 markers are migrated on read.

## 10. Inline comment format

```
**WARNING:** Missing `on SessionExpiredException` handler

<3–6 sentence body naming symbols and tracing the failure path>

```suggestion
<replacement for lines line..end_line>
```

<!-- air-id:1a2b3c4d -->
```

Multi-line findings use `start_line` = `line`, `line` = `end_line` (GitHub's convention).
The review object's own body is just "Reviewed N file(s) at `abc1234` — k new inline
comments. See the **Code Review Summary** comment for the full report." and no review is
created when there are no new comments.
