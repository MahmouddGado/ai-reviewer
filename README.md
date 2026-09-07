# AI Reviewer

A CodeRabbit-style AI code reviewer packaged as a GitHub Action, powered by **z.ai GLM-5.3**. It reviews every pull request and **re-reviews incrementally on each
new commit**, keeping a single summary comment up to date and posting inline, one-click committable
suggestions.

> **Model backend:** Uses the `@anthropic-ai/sdk` pointed at `https://api.z.ai/api/anthropic`, so
> GLM models work with no code changes. Swap `model:` (e.g. `glm-4.6`) and `base_url:` to use any
> Anthropic-compatible provider — including Anthropic itself (`model: claude-sonnet-5`, drop `base_url`).

For accounts with a current or past GLM Coding Plan subscription, Z.ai currently requires the
OpenAI-compatible protocol for GLM-5.3. Set `api_protocol: openai`; the default endpoint becomes
`https://api.z.ai/api/coding/paas/v4`. Otherwise the default remains `api_protocol: anthropic`
with `https://api.z.ai/api/anthropic`. An explicit `base_url` overrides either default.
See [Z.ai's GLM-5.3 protocol and account requirements](https://docs.z.ai/guides/llm/glm-5.3).

## Features

- **Automatic reviews** on PR open and on every push (incremental — only the new changes).
- **One sticky summary comment**, replaced with a fresh, independent review on each pass:
  findings and file outcomes from that pass only, followed by three previous review blocks,
  newest first. Previous findings are not added to the new summary.
- **Bounded chunks**, splitting oversized files at hunk and line boundaries. Results from all
  chunks in a pass become one summary. Failed or truncated chunks mark the review incomplete.
- **Per-review usage**: input, output, and cache tokens stay with the review that used them.
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
<details><summary><b>Files Reviewed (4 files — incremental pass on 004a79e)</b></summary>

- `lib/payment_notifier.dart` - clean; previous stale-id finding verified fixed
- `test/payment_notifier_test.dart` - clean; regression test pins cancel → restart behavior

</details>

<details><summary><b>Previous Review Summaries</b> (3 snapshots, latest commit b364bc6)</summary>
…the previously-authoritative status, findings, and file roster…
</details>

**Overall Assessment:** …

<sub>Reviewed by glm-5.3 · Input: 29K · Output: 7.3K · Cached: 302.5K</sub>
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
  5. split diffs into chunks of <= batch_chars, including oversized files
  6. model review per batch → new findings, per-file outcomes, and prior-finding verdicts
  7. verification pass per batch (drop false positives and re-check resolution verdicts)
  8. post inline comments (deduped by a hidden per-finding id)
  9. combine this pass's results, archive the previous summary, replace the current block
```

### Staying accurate across commits

Every summary describes one review pass. The latest block is first, followed by the previous
three blocks in newest-first order. Historical findings never inflate the latest issue totals:

- Every inline comment carries a hidden `<!-- air-id:… -->` derived from *path + title* — not the
  line — so a finding that drifts down the file is still recognised as the same finding rather than
  posted twice.
- On each new commit, findings from earlier reviews are supplied to the model alongside the
  incremental diff for their changed files. Each receives a `resolved`, `unresolved`, or `unknown`
  verdict for per-file fix notes. Only findings actually reported in this pass appear in its totals.
- GitHub's **outdated** flag means an anchor changed, not that the bug was fixed. If the issue remains,
  the action can post a refreshed comment on the new commit; live comments are still deduplicated.
- Findings and observations in previous blocks remain as recorded, even when files move or are deleted.
- `@bot full review` creates a new independent review of the entire PR, archiving the previous block
  even when the commit SHA is unchanged. Repeated automatic events for a completed SHA do no work.
- The current roster describes only the latest pass; up to three prior authoritative summaries are
  retained in a collapsed history section. Failed or truncated chunks are marked for retry and do
  not advance the completed-review SHA. The next run retries from the last completed checkpoint.
  The character budget covers rendered diff content and file headings; instructions and verification
  responses add request overhead. Exceptionally long individual lines may span fragments.

State lives in a hidden, gzipped+base64 `<!-- AI-REVIEW-STATE v3 … -->` marker on the sticky comment,
which is how a stateless Action remembers what it already reviewed. It's encoded rather than raw JSON
because findings quote real code, and a title containing `-->` would otherwise close the HTML comment
early and corrupt the page. v1 and v2 markers are migrated automatically, so PRs opened under an older
build keep their position instead of being re-reviewed from scratch.

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
| `src/review/accumulate.ts` | Normalize and deduplicate findings and observations (pure) |
| `src/review/batch.ts` | Split large diffs and pack bounded chunks |
| `src/review/openai.ts` | OpenAI-compatible transport for Coding Plan accounts |
| `src/review/render.ts` | Summary-comment markdown (pure, unit-tested) |
| `src/review/orchestrator.ts` | The 8-step flow |
| `src/commands/handler.ts` | `@bot` command parsing & handling |

## License

MIT
