import * as core from "@actions/core";
import { Octokit, Repo } from "../github/client";
import { Config } from "../types";
import { ReviewEngine } from "../review/engine";
import { runReview } from "../review/orchestrator";
import { readState, writeSummary } from "../github/state";
import { renderSummaryComment } from "../review/render";
import { postIssueComment } from "../github/review";

export type Command =
  | "review"
  | "full-review"
  | "summary"
  | "resolve"
  | "pause"
  | "resume"
  | "help"
  | null;

const MENTION = /@(?:bot|coderabbitai|ai-reviewer)\b/i;

/** Parse a PR/issue comment body into a command, or null if it isn't for us. */
export function parseCommand(body: string): Command {
  if (!MENTION.test(body)) return null;
  const text = body.replace(MENTION, "").trim().toLowerCase();
  if (/^full\s+review/.test(text)) return "full-review";
  if (/^review/.test(text)) return "review";
  if (/^summary/.test(text)) return "summary";
  if (/^resolve/.test(text)) return "resolve";
  if (/^pause/.test(text)) return "pause";
  if (/^resume/.test(text)) return "resume";
  if (/^help/.test(text) || text === "") return "help";
  // Free-form question mentioning the bot → treat as a review request for now.
  return "review";
}

export async function handleCommand(
  command: Command,
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
  config: Config,
  engine: ReviewEngine,
): Promise<void> {
  switch (command) {
    case "review":
      await runReview(octokit, repo, pull_number, config, engine, {
        forceFull: false,
        summaryOnly: false,
      });
      break;

    case "full-review":
      await runReview(octokit, repo, pull_number, config, engine, {
        forceFull: true,
        summaryOnly: false,
      });
      break;

    case "summary":
      // Redraws the sticky comment from stored state — no model call, no tokens.
      await runReview(octokit, repo, pull_number, config, engine, {
        forceFull: false,
        summaryOnly: true,
      });
      break;

    case "resolve":
      await resolveThreads(octokit, repo, pull_number);
      await postIssueComment(
        octokit,
        repo,
        pull_number,
        "✅ Resolved all open AI review threads.",
      );
      break;

    case "pause":
    case "resume": {
      const state = await readState(octokit, repo, pull_number);
      state.paused = command === "pause";
      await writeSummary(octokit, repo, pull_number, state, (budget) =>
        renderSummaryComment(
          {
            findings: state.findings,
            observations: state.observations,
            files: state.files,
            assessment: state.assessment,
            model: state.model || engine.model,
            tokens: state.tokens,
          },
          budget,
        ).body,
      );
      await postIssueComment(
        octokit,
        repo,
        pull_number,
        command === "pause"
          ? "⏸️ Automatic reviews paused. Comment `@bot resume` to re-enable."
          : "▶️ Automatic reviews resumed.",
      );
      break;
    }

    case "help":
      await postIssueComment(octokit, repo, pull_number, helpText());
      break;

    default:
      core.info("Comment was not a recognized command; ignoring.");
  }
}

/** Resolve open review threads authored by the bot via GraphQL. */
async function resolveThreads(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
): Promise<void> {
  const query = `
    query($owner:String!,$repo:String!,$pr:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100){ nodes { id isResolved } }
        }
      }
    }`;
  try {
    const res: any = await octokit.graphql(query, {
      owner: repo.owner,
      repo: repo.repo,
      pr: pull_number,
    });
    const threads = res.repository.pullRequest.reviewThreads.nodes.filter(
      (t: any) => !t.isResolved,
    );
    for (const t of threads) {
      await octokit.graphql(
        `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id } } }`,
        { id: t.id },
      );
    }
  } catch (err: any) {
    core.warning(`Could not resolve threads: ${err.message}`);
  }
}

function helpText(): string {
  return [
    "### AI Reviewer — commands",
    "",
    "| Command | Action |",
    "| --- | --- |",
    "| `@bot review` | Incremental review of what changed since last review |",
    "| `@bot full review` | Re-review the whole PR from scratch (resets the running totals) |",
    "| `@bot summary` | Redraw the summary comment from stored state (no model call) |",
    "| `@bot resolve` | Resolve all AI review threads |",
    "| `@bot pause` / `@bot resume` | Stop / restart automatic reviews |",
    "| `@bot help` | Show this list |",
    "",
    "Reviews also run automatically on every push.",
  ].join("\n");
}
