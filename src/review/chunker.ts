import * as core from "@actions/core";
import { minimatch } from "minimatch";
import { Config } from "../types";
import { DiffFile } from "../github/diff";

const ALWAYS_IGNORE = [
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.min.js",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/__generated__/**",
  "**/*.snap",
];

/** Why a changed file never reached the model. Drives the Files Reviewed roster. */
export type DropReason =
  | "generated"
  | "filtered"
  | "cap"
  | "binary"
  | "deleted";

export interface DroppedFile {
  path: string;
  reason: DropReason;
}

export interface SelectedFiles {
  files: DiffFile[];
  dropped: DroppedFile[];
  skippedByFilter: number;
  skippedByCap: number;
}

/** Apply path filters, drop noise/binary/deleted files, and cap to max_files. */
export function selectFiles(
  diffFiles: DiffFile[],
  config: Config,
): SelectedFiles {
  const userExcludes = extractNegated(config.path_filters);
  const includes = extractPositive(config.path_filters);
  const dropped: DroppedFile[] = [];

  const kept = diffFiles.filter((f) => {
    if (f.isDeleted) {
      dropped.push({ path: f.path, reason: "deleted" });
      return false;
    }
    if (f.isBinary || f.commentableLines.size === 0) {
      dropped.push({ path: f.path, reason: "binary" });
      return false;
    }
    if (ALWAYS_IGNORE.some((g) => minimatch(f.path, g))) {
      dropped.push({ path: f.path, reason: "generated" });
      return false;
    }
    if (userExcludes.some((g) => minimatch(f.path, g))) {
      dropped.push({ path: f.path, reason: "filtered" });
      return false;
    }
    if (includes.length && !includes.some((g) => minimatch(f.path, g))) {
      dropped.push({ path: f.path, reason: "filtered" });
      return false;
    }
    return true;
  });

  // Largest changes first, so if we hit the cap we review the most substantial files.
  kept.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

  const files = kept.slice(0, config.max_files);
  for (const f of kept.slice(config.max_files)) {
    dropped.push({ path: f.path, reason: "cap" });
  }

  const skippedByCap = kept.length - files.length;
  if (skippedByCap > 0) {
    core.warning(
      `${skippedByCap} file(s) exceeded max_files=${config.max_files} and were not reviewed.`,
    );
  }

  return {
    files,
    dropped,
    skippedByFilter: dropped.length - skippedByCap,
    skippedByCap,
  };
}

function extractNegated(filters: string[]): string[] {
  return filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
}
function extractPositive(filters: string[]): string[] {
  return filters.filter((f) => !f.startsWith("!"));
}
