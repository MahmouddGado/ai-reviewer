import { DiffFile } from "../github/diff";

/** Pack whole files when possible; oversized diffs are split without dropping text. */
export function planBatches(files: DiffFile[], charBudget: number): DiffFile[][] {
  if (!Number.isFinite(charBudget) || charBudget <= 0) return files.length ? [files] : [];
  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;
  for (const file of files) {
    for (const part of splitFile(file, charBudget)) {
      const cost = part.rendered.length + part.path.length + 128;
      if (current.length && size + cost > charBudget) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(part);
      size += cost;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function splitFile(file: DiffFile, budget: number): DiffFile[] {
  const available = budget - file.path.length - 128;
  if (available < 64) throw new Error(`batch_chars is too small for ${file.path}; increase the budget.`);
  if (file.rendered.length <= available) return [file];

  // Prefer hunk boundaries, then line boundaries. Even a single very long line
  // is retained across parts; only visible numbered lines may anchor findings.
  const pieces: string[] = [];
  let current = "";
  const flush = () => { if (current) pieces.push(current); current = ""; };
  for (const hunk of file.rendered.split(/(?=^@@ )/m)) {
    if (hunk.length <= available) {
      if (current.length + hunk.length > available) flush();
      current += hunk;
      continue;
    }
    flush();
    for (const line of hunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (current.length + line.length > available) flush();
      let rest = line;
      while (rest.length > available) {
        pieces.push(rest.slice(0, available));
        rest = rest.slice(available);
      }
      current += rest;
    }
  }
  flush();
  return pieces.map((rendered, index) => ({
    ...file,
    rendered,
    part: { index: index + 1, total: pieces.length },
    commentableLines: new Set([...rendered.matchAll(/^\s*(\d+) [ +] /gm)]
      .map((match) => Number(match[1])).filter((line) => file.commentableLines.has(line))),
  }));
}
