import * as github from "@actions/github";

export function makeOctokit(token: string) {
  return github.getOctokit(token);
}

export type Octokit = ReturnType<typeof makeOctokit>;

export interface Repo {
  owner: string;
  repo: string;
}
