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

export interface SelectedFiles {
  files: DiffFile[];
  skippedByFilter: number;
  skippedByCap: number;
}

/** Apply path filters, drop noise/binary/deleted files, and cap to max_files. */
export function selectFiles(
  diffFiles: DiffFile[],
  config: Config,
): SelectedFiles {
  const excludes = [...ALWAYS_IGNORE, ...extractNegated(config.path_filters)];
  const includes = extractPositive(config.path_filters);

  let skippedByFilter = 0;

  const kept = diffFiles.filter((f) => {
    if (f.isBinary || f.isDeleted || f.commentableLines.size === 0) {
      skippedByFilter++;
      return false;
    }
    if (excludes.some((g) => minimatch(f.path, g))) {
      skippedByFilter++;
      return false;
    }
    if (includes.length && !includes.some((g) => minimatch(f.path, g))) {
      skippedByFilter++;
      return false;
    }
    return true;
  });

  // Largest changes first, so if we hit the cap we review the most substantial files.
  kept.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

  const files = kept.slice(0, config.max_files);
  const skippedByCap = kept.length - files.length;
  if (skippedByCap > 0) {
    core.warning(
      `${skippedByCap} file(s) exceeded max_files=${config.max_files} and were not reviewed.`,
    );
  }

  return { files, skippedByFilter, skippedByCap };
}

function extractNegated(filters: string[]): string[] {
  return filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
}
function extractPositive(filters: string[]): string[] {
  return filters.filter((f) => !f.startsWith("!"));
}
