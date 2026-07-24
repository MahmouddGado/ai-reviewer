# 🐰 AI Reviewer

A CodeRabbit-style AI code reviewer packaged as a GitHub Action, powered by **z.ai GLM 5.2** (via its
Anthropic-compatible endpoint). It reviews every pull request and **re-reviews incrementally on each
new commit**, posting a walkthrough summary plus inline, one-click committable suggestions.

> **Model backend:** Uses the `@anthropic-ai/sdk` pointed at `https://api.z.ai/api/anthropic`, so
> GLM models work with no code changes. Swap `model:` (e.g. `glm-4.6`) and `base_url:` to use any
> Anthropic-compatible provider — including Anthropic itself (`model: claude-sonnet-5`, drop `base_url`).

## Features

- **Automatic reviews** on PR open and on every push (incremental — only the new changes).
- **Walkthrough** comment (summary + changed-files table), updated in place.
- **Inline findings** with severity (⛔ potential issue / ⚠️ refactor / 🔹 nitpick) and category.
- **Committable suggestions** — `\`\`\`suggestion` blocks you apply with one click.
- **Verification pass** to cut false positives.
- **`@bot` commands**: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`.
- **`.aireviewer.yaml`** config: profiles, path filters, path instructions, auto-review rules.

## Quick start

1. Add a `ZAI_API_KEY` secret to the repo (or org) — get one at https://z.ai.
2. Copy `examples/ai-review.yml` to `.github/workflows/ai-review.yml`.
3. (Optional) Copy `examples/.aireviewer.yaml` to the repo root.
4. Open a PR — the review appears within a minute.

See `../coderabbit-clone-usage.md` (English) or `../coderabbit-clone-usage-ar.md` (Arabic) for the
full usage guide.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # bundle to dist/index.js with @vercel/ncc
```

Commit the `dist/` folder — GitHub Actions runs the bundled output. Then tag a release:

```bash
git tag -a v1 -m "v1" && git push origin v1
```

## How it works

```
event → router → orchestrator:
  1. load .aireviewer.yaml (from PR head, via API — no checkout needed)
  2. resolve scope: full (opened) vs incremental (synchronize → lastReviewedSha...head)
  3. fetch diff, parse hunks → commentable line set (prevents 422s)
  4. select files (path filters, max_files cap)
  5. Claude review (tool-use structured output) → findings
  6. verification pass (drop false positives)
  7. post review: walkthrough (upsert) + inline comments w/ suggestions (deduped)
  8. persist lastReviewedSha in a hidden marker inside the walkthrough comment
```

State lives in a hidden `<!-- AI-REVIEWER-STATE {...} -->` marker on the PR, which is how a stateless
Action remembers what it already reviewed.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | Entry + event router (pull_request / issue_comment) |
| `src/config.ts` | Load & validate `.aireviewer.yaml` |
| `src/github/diff.ts` | Fetch & parse diffs; compute commentable lines |
| `src/github/state.ts` | Read/write the hidden state marker |
| `src/github/review.ts` | Build & post inline comments + suggestions; dedup |
| `src/review/scope.ts` | Full vs incremental range resolution |
| `src/review/engine.ts` | Claude calls (review + verify) via tool use |
| `src/review/orchestrator.ts` | The 8-step flow |
| `src/commands/handler.ts` | `@bot` command parsing & handling |

## License

MIT
