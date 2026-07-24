import * as core from "@actions/core";
import * as github from "@actions/github";
import { makeOctokit, Repo } from "./github/client";
import { loadConfig } from "./config";
import { Config } from "./types";
import { ReviewEngine } from "./review/engine";
import { runReview } from "./review/orchestrator";
import { readState } from "./github/state";
import { handleCommand, parseCommand } from "./commands/handler";
import { getPrDetails } from "./review/context";

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("anthropic_api_key", { required: true });
    const token = core.getInput("github_token", { required: true });
    const model = core.getInput("model") || "claude-sonnet-5";
    const configPath = core.getInput("config_path") || ".aireviewer.yaml";

    const overrides: Partial<Config> = {};
    const maxFiles = Number(core.getInput("max_files"));
    if (Number.isFinite(maxFiles) && maxFiles > 0) overrides.max_files = maxFiles;
    const profile = core.getInput("review_profile");
    if (profile === "quiet" || profile === "chill" || profile === "assertive") {
      overrides.profile = profile;
    }

    const octokit = makeOctokit(token);
    const ctx = github.context;
    const repo: Repo = { owner: ctx.repo.owner, repo: ctx.repo.repo };
    const engine = new ReviewEngine(apiKey, model);

    const pull_number = await resolvePrNumber(octokit, repo, ctx);
    if (!pull_number) {
      core.info("Event is not associated with a pull request. Skipping.");
      return;
    }

    // Config is read from the PR head so branch-level config changes take effect.
    const pr = await getPrDetails(octokit, repo, pull_number);
    const config = await loadConfig(
      octokit,
      repo,
      pr.headSha,
      configPath,
      overrides,
    );

    switch (ctx.eventName) {
      case "pull_request":
      case "pull_request_target":
        await onPullRequest(octokit, repo, pull_number, config, engine, ctx);
        break;

      case "issue_comment":
      case "pull_request_review_comment": {
        const body: string =
          ctx.payload.comment?.body ?? "";
        // Ignore the bot's own comments to avoid loops.
        if (ctx.payload.comment?.user?.type === "Bot") {
          core.info("Ignoring bot-authored comment.");
          return;
        }
        const command = parseCommand(body);
        if (!command) {
          core.info("Comment is not addressed to the reviewer. Skipping.");
          return;
        }
        core.info(`Handling command: ${command}`);
        await handleCommand(command, octokit, repo, pull_number, config, engine);
        break;
      }

      default:
        core.info(`Unhandled event: ${ctx.eventName}. Skipping.`);
    }
  } catch (err: any) {
    core.setFailed(`AI Reviewer failed: ${err.message}`);
  }
}

async function onPullRequest(
  octokit: ReturnType<typeof makeOctokit>,
  repo: Repo,
  pull_number: number,
  config: Config,
  engine: ReviewEngine,
  ctx: typeof github.context,
): Promise<void> {
  const action = ctx.payload.action;
  const prPayload = ctx.payload.pull_request;

  if (!config.auto_review.enabled) {
    core.info("auto_review.enabled is false. Skipping automatic review.");
    return;
  }

  // Respect draft, base-branch, and title-keyword rules.
  if (prPayload?.draft && !config.auto_review.drafts) {
    core.info("Draft PR and drafts disabled. Skipping.");
    return;
  }
  const baseRef: string = prPayload?.base?.ref ?? "";
  const baseOk = config.auto_review.base_branches.some((re) =>
    new RegExp(`^${re}$`).test(baseRef),
  );
  if (!baseOk) {
    core.info(`Base branch '${baseRef}' not in base_branches. Skipping.`);
    return;
  }
  const title: string = prPayload?.title ?? "";
  if (
    config.auto_review.ignore_title_keywords.some((k) =>
      title.toLowerCase().includes(k.toLowerCase()),
    )
  ) {
    core.info("Title contains an ignore keyword. Skipping.");
    return;
  }

  const state = await readState(octokit, repo, pull_number);
  if (state.paused) {
    core.info("Reviews are paused for this PR. Skipping.");
    return;
  }

  // opened / reopened / ready_for_review → full; synchronize → incremental.
  const forceFull = action !== "synchronize";
  await runReview(octokit, repo, pull_number, config, engine, {
    forceFull,
    summaryOnly: false,
  });
}

/** Determine the PR number from whichever event triggered the run. */
async function resolvePrNumber(
  _octokit: ReturnType<typeof makeOctokit>,
  _repo: Repo,
  ctx: typeof github.context,
): Promise<number | null> {
  if (ctx.payload.pull_request?.number) return ctx.payload.pull_request.number;
  // issue_comment on a PR: the issue IS the PR, but only if it has pull_request set.
  if (ctx.payload.issue?.pull_request && ctx.payload.issue.number) {
    return ctx.payload.issue.number;
  }
  return null;
}

run();
