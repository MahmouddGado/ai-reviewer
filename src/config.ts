import * as core from "@actions/core";
import { parse as parseYaml } from "yaml";
import { Config, ConfigSchema } from "./types";
import { Octokit, Repo } from "./github/client";

/**
 * Load .aireviewer.yaml from the repository at a given ref via the GitHub API,
 * so the action works without a `checkout` step. Falls back to defaults when the
 * file is absent or invalid.
 */
export async function loadConfig(
  octokit: Octokit,
  repo: Repo,
  ref: string,
  path: string,
  overrides: Partial<Config>,
): Promise<Config> {
  let raw: unknown = {};

  try {
    const res = await octokit.rest.repos.getContent({
      ...repo,
      path,
      ref,
    });
    // getContent returns an object with base64 content for files.
    const data = res.data as { content?: string; encoding?: string };
    if (data.content) {
      const text = Buffer.from(data.content, "base64").toString("utf8");
      raw = parseYaml(text) ?? {};
    }
  } catch (err: any) {
    if (err.status === 404) {
      core.info(`No ${path} found — using defaults.`);
    } else {
      core.warning(`Could not read ${path}: ${err.message}. Using defaults.`);
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    core.warning(
      `Invalid ${path}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}. Using defaults.`,
    );
    return applyOverrides(ConfigSchema.parse({}), overrides);
  }

  return applyOverrides(parsed.data, overrides);
}

function applyOverrides(config: Config, overrides: Partial<Config>): Config {
  return { ...config, ...stripUndefined(overrides) };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}
