import parseDiff from "parse-diff";
import { Octokit, Repo } from "./client";

export interface DiffFile {
  path: string; // new path (RIGHT side)
  oldPath: string;
  isDeleted: boolean;
  isBinary: boolean;
  /** Line numbers in the NEW file that a comment can anchor to (added + context). */
  commentableLines: Set<number>;
  /** Rendered, line-numbered hunks for the model to read. */
  rendered: string;
  additions: number;
  deletions: number;
  part?: { index: number; total: number };
}

/** Fetch the unified diff for a full PR. */
export async function getPrDiff(
  octokit: Octokit,
  repo: Repo,
  pull_number: number,
): Promise<string> {
  const res = await octokit.rest.pulls.get({
    ...repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // With the diff media type, data is the raw diff string.
  return res.data as unknown as string;
}

/** Fetch the unified diff for a commit range (base...head) — used for incremental reviews. */
export async function getRangeDiff(
  octokit: Octokit,
  repo: Repo,
  base: string,
  head: string,
): Promise<string> {
  const res = await octokit.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${base}...${head}`,
    mediaType: { format: "diff" },
  });
  return res.data as unknown as string;
}

/**
 * Parse a unified diff into per-file structures with:
 *  - the set of NEW-file line numbers a comment can legally target, and
 *  - a rendered, line-numbered view for the model.
 *
 * This is what keeps inline comments from 422-ing: we only ever let the model
 * (and later the poster) reference lines that actually appear in the diff.
 */
export function parseDiffFiles(diffText: string): DiffFile[] {
  const files = parseDiff(diffText);
  const out: DiffFile[] = [];

  for (const f of files) {
    const path = f.to && f.to !== "/dev/null" ? f.to : f.from ?? "";
    if (!path) continue;

    const commentable = new Set<number>();
    const lines: string[] = [];
    let additions = 0;
    let deletions = 0;

    for (const chunk of f.chunks) {
      lines.push(chunk.content); // the @@ ... @@ header
      for (const change of chunk.changes) {
        if (change.type === "add") {
          const ln = (change as any).ln as number;
          commentable.add(ln);
          additions++;
          lines.push(`${pad(ln)} + ${change.content.slice(1)}`);
        } else if (change.type === "normal") {
          const ln = (change as any).ln2 as number;
          commentable.add(ln); // context lines are commentable too
          lines.push(`${pad(ln)}   ${change.content.slice(1)}`);
        } else if (change.type === "del") {
          deletions++;
          lines.push(`${pad("")} - ${change.content.slice(1)}`);
        }
      }
    }

    out.push({
      path,
      oldPath: f.from ?? path,
      isDeleted: f.deleted === true || f.to === "/dev/null",
      isBinary: (f as any).binary === true,
      commentableLines: commentable,
      rendered: lines.join("\n"),
      additions,
      deletions,
    });
  }

  return out;
}

function pad(n: number | string): string {
  return String(n).padStart(5, " ");
}
