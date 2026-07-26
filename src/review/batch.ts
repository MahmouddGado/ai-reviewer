import * as core from "@actions/core";
import { DiffFile } from "../github/diff";

/**
 * Splitting exists so `max_files: 0` (unlimited) is actually usable: a 300-file
 * PR cannot go into one request, but it can go into eight. Nothing is ever
 * dropped or truncated here — a file too big for a whole batch still gets its
 * own batch and is sent in full.
 */
export function planBatches(
  files: DiffFile[],
  charBudget: number,
): DiffFile[][] {
  if (files.length === 0) return [];
  if (!Number.isFinite(charBudget) || charBudget <= 0) return [files];

  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;

  for (const f of files) {
    const cost = fileCost(f);

    // A single file over budget goes alone rather than being cut down.
    if (cost >= charBudget) {
      if (current.length) {
        batches.push(current);
        current = [];
        size = 0;
      }
      batches.push([f]);
      core.info(
        `${f.path} is ${f.rendered.length} chars — reviewing it in a batch of its own.`,
      );
      continue;
    }

    if (current.length && size + cost > charBudget) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += cost;
  }

  if (current.length) batches.push(current);
  return batches;
}

/** Rendered diff plus the per-file heading/fence overhead `buildUserPrompt` adds. */
function fileCost(f: DiffFile): number {
  return f.rendered.length + f.path.length + 32;
}
