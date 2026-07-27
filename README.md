# AI Reviewer

A CodeRabbit-style AI code reviewer packaged as a GitHub Action, powered by **z.ai GLM 5.2** (via its
Anthropic-compatible endpoint). It reviews every pull request and **re-reviews incrementally on each
new commit**, keeping a single summary comment up to date and posting inline, one-click committable
suggestions.

> **Model backend:** Uses the `@anthropic-ai/sdk` pointed at `https://api.z.ai/api/anthropic`, so
> GLM models work with no code changes. Swap `model:` (e.g. `glm-4.6`) and `base_url:` to use any
> Anthropic-compatible provider — including Anthropic itself (`model: claude-sonnet-5`, drop `base_url`).

## Features

- **Automatic reviews** on PR open and on every push (incremental — only the new changes).
- **One sticky summary comment**, rewritten in place on every commit and always describing the
  **whole PR**: severity counts, issue tables, out-of-diff observations, the reviewed-files roster,
  an overall assessment, and running token spend.
- **Inline findings** in the form `**WARNING:** <title>` followed by an explanation that names the
  symbols involved and traces the actual failure path.
- **Severity**: `CRITICAL` / `WARNING` / `SUGGESTION`.
- **Committable suggestions** — ` ```suggestion ` blocks you apply with one click.
- **Verification pass** to cut false positives.
- **`@bot` commands**: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`.
- **`.aireviewer.yaml`** config: profiles, path filters, path instructions, auto-review rules.

## What it posts

The sticky comment:

```markdown
## Code Review Summary

**Status:** 2 Issues Found | **Recommendation:** Address before merge

### Overview
| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| WARNING | 2 |
| SUGGESTION | 0 |

<details><summary><b>Issue Details (click to expand)</b></summary> … per-severity tables …
<details><summary><b>Other Observations (not in diff)</b></summary> … </details>
<details><summary><b>Files Reviewed (41 files)</b></summary> … `path` - N issues … </details>

**Overall Assessment:** …

<sub>Reviewed by glm-5.2 · 833,431 tokens</sub>
```

Run `npm run preview` to print a full rendered example without touching the API or GitHub.

Inline comments:

```markdown
**WARNING:** Missing `on SessionExpiredException` handler

`confirmReview` catches `on AppFailure` and `catch (e, st)` but does not handle
`on SessionExpiredException` explicitly — unlike `fetchSalesData`, `updateRecord`, and
`deleteRecord` in this same provider. …
```

## Quick start

1. Add a `ZAI_API_KEY` secret to the repo (or org) — get one at https://z.ai.
2. Copy `examples/ai-review.yml` to `.github/workflows/ai-review.yml`.
   Make sure the `uses:` line carries a ref — `uses: <owner>/ai-reviewer@v1`, not
   `uses: <owner>/ai-reviewer`, which GitHub cannot resolve.
3. (Optional) Copy `examples/.aireviewer.yaml` to the repo root.
4. Open a PR — the review appears within a minute.

See `../coderabbit-clone-usage.md` (English) or `../coderabbit-clone-usage-ar.md` (Arabic) for the
full usage guide.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test over the pure renderers, state, and merge logic
npm run preview       # print a rendered summary comment for a fixture
npm run build         # bundle to dist/index.js with @vercel/ncc
```

Commit the `dist/` folder in the same commit as any `src/` change — GitHub Actions runs the bundled
output, so a stale bundle silently runs old code. Then move the release tag:

```bash
git tag -f v1 && git push -f origin v1
```

## How it works

```
event → router → orchestrator:
  1. load .aireviewer.yaml (from PR head, via API — no checkout needed)
  2. resolve scope: full (opened) vs incremental (synchronize → lastReviewedSha...head)
  3. fetch diff, parse hunks → commentable line set (prevents 422s)
  4. select files (path filters, optional max_files cap), recording why each was dropped
  5. split into batches of <= batch_chars so an unlimited file count still fits a request
  6. model review per batch → new findings + verdicts for relevant findings from earlier commits
  7. verification pass per batch (drop false positives and re-check resolution verdicts)
  8. post inline comments (deduped by a hidden per-finding id)
  9. merge into the running totals, then upsert the sticky summary comment
```

### Staying accurate across commits

The summary is cumulative, so it needs to know which findings are still open:

- Every inline comment carries a hidden `<!-- air-id:… -->` derived from *path + title* — not the
  line — so a finding that drifts down the file is still recognised as the same finding rather than
  posted twice.
- On each new commit, findings from earlier reviews are supplied to the model alongside the
  incremental diff for their changed files. Each receives a `resolved`, `unresolved`, or `unknown`
  verdict. Only an explicit `resolved` verdict removes it from the totals; missing context keeps it.
- GitHub's **outdated** flag means an anchor changed, not that the bug was fixed. If the issue remains,
  the action can post a refreshed comment on the new commit; live comments are still deduplicated.
- Surviving live findings have their line refreshed from GitHub, so the table tracks the file as it
  moves. Findings and observations are removed immediately when their file is deleted.
- Observations have no comment to track, so they're re-evaluated whenever their file is reviewed
  again — file-level granularity is the honest limit there.
- `@bot full review` resets the totals and rebuilds from scratch.

State lives in a hidden, gzipped+base64 `<!-- AI-REVIEW-STATE v2 … -->` marker on the sticky comment,
which is how a stateless Action remembers what it already reviewed. It's encoded rather than raw JSON
because findings quote real code, and a title containing `-->` would otherwise close the HTML comment
early and corrupt the page. v1 markers are migrated automatically, so PRs opened under an older build
keep their position instead of being re-reviewed from scratch.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | Entry + event router (pull_request / issue_comment) |
| `src/config.ts` | Load & validate `.aireviewer.yaml` |
| `src/github/diff.ts` | Fetch & parse diffs; compute commentable lines |
| `src/github/state.ts` | Read/write the hidden state marker; upsert the sticky comment |
| `src/github/review.ts` | Build & post inline comments + suggestions; dedup via `air-id` |
| `src/review/scope.ts` | Full vs incremental range resolution |
| `src/review/chunker.ts` | File selection, with a drop reason per file |
| `src/review/engine.ts` | Model calls (review + verify) via tool use; token accounting |
| `src/review/accumulate.ts` | Merge/expire findings and observations across commits (pure) |
| `src/review/render.ts` | Summary-comment markdown (pure, unit-tested) |
| `src/review/orchestrator.ts` | The 8-step flow |
| `src/commands/handler.ts` | `@bot` command parsing & handling |

## License

MIT
