import { Octokit, Repo } from "../github/client";

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  draft: boolean;
}

/** Load PR details (works from any event type, including issue_comment). */
export async function getPrDetails(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
): Promise<PrDetails> {
  const { data } = await octokit.rest.pulls.get({ ...repo, pull_number });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    baseRef: data.base.ref,
    headRef: data.head.ref,
    baseSha: data.base.sha,
    headSha: data.head.sha,
    draft: data.draft ?? false,
  };
}

/** Pull the text of issues referenced in the PR body (e.g. "Closes #12"). */
export async function getLinkedIssues(
  octokit: Octokit,
  repo: Repo,
  body: string,
): Promise<string> {
  const refs = new Set<number>();
  const re =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) refs.add(Number(m[1]));

  const chunks: string[] = [];
  for (const n of [...refs].slice(0, 5)) {
    try {
      const { data } = await octokit.rest.issues.get({
        ...repo,
        issue_number: n,
      });
      chunks.push(`#${n} — ${data.title}\n${(data.body ?? "").slice(0, 1000)}`);
    } catch {
      /* ignore unreadable issues */
    }
  }
  return chunks.join("\n\n");
}
