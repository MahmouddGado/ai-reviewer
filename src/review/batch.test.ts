import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Config, ConfigSchema } from "../types";
import { DiffFile } from "../github/diff";
import { planBatches } from "./batch";
import { selectFiles } from "./chunker";
import { buildInlineComments } from "../github/review";
import { Finding } from "../types";

function file(path: string, renderedChars: number): DiffFile {
  return {
    path,
    oldPath: path,
    isDeleted: false,
    isBinary: false,
    commentableLines: new Set([1]),
    rendered: "x".repeat(renderedChars),
    additions: renderedChars,
    deletions: 0,
  };
}

const config = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({}),
  ...over,
});

describe("planBatches", () => {
  it("keeps everything in one request when it fits", () => {
    const files = [file("a.ts", 100), file("b.ts", 100)];
    const batches = planBatches(files, 10000);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
  });

  it("splits across requests without dropping a file", () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`f${i}.ts`, 1000));
    const batches = planBatches(files, 3000);
    assert.ok(batches.length > 1, "expected more than one batch");
    const seen = batches.flat().map((f) => f.path);
    assert.equal(seen.length, 20);
    assert.equal(new Set(seen).size, 20);
  });

  it("splits an oversized file without truncating its content", () => {
    const files = [file("small.ts", 100), file("huge.ts", 50000)];
    const batches = planBatches(files, 5000);
    const huge = batches.flat().filter((f) => f.path === "huge.ts");
    assert.ok(huge.length > 1);
    assert.equal(huge.map((f) => f.rendered).join(""), files[1].rendered);
    for (const batch of batches) {
      assert.ok(batch.reduce((size, f) => size + f.rendered.length + f.path.length + 128, 0) <= 5000);
    }
    // and the small file is still reviewed
    assert.ok(batches.flat().some((f) => f.path === "small.ts"));
  });

  it("preserves original line numbers across large hunks", () => {
    const source = file("a.ts", 0);
    source.rendered = "@@ -1,30 +1,30 @@\n" + Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(5)} + statement${i};\n`).join("");
    source.commentableLines = new Set(Array.from({ length: 30 }, (_, i) => i + 1));
    const parts = planBatches([source], 300).flat();
    assert.ok(parts.length > 1);
    assert.equal(parts.map((part) => part.rendered).join(""), source.rendered);
    assert.deepEqual(new Set(parts.flatMap((part) => [...part.commentableLines])), source.commentableLines);
    assert.deepEqual(parts.map((part) => part.part?.index), parts.map((_, i) => i + 1));
    const findings: Finding[] = [1, 30].map((line) => ({ path: source.path, line, severity: "WARNING", category: "bug", title: `Problem ${line}`, summary: "Problem", body: "Explanation" }));
    const comments = buildInlineComments(findings, parts, { byId: new Map(), legacy: new Set() });
    assert.equal(comments.comments.length, 2, "anchors in early and late chunks both survive");
  });

  it("returns no batches for no files", () => {
    assert.deepEqual(planBatches([], 5000), []);
  });
});

describe("selectFiles with max_files: 0", () => {
  it("reviews every file and caps nothing", () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`, 50));
    const out = selectFiles(files, config({ max_files: 0 }));
    assert.equal(out.files.length, 300);
    assert.equal(out.skippedByCap, 0);
    assert.equal(out.dropped.length, 0);
  });

  it("still honours an explicit cap when one is set", () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`, 50));
    const out = selectFiles(files, config({ max_files: 4 }));
    assert.equal(out.files.length, 4);
    assert.equal(out.skippedByCap, 6);
  });

  it("defaults to unlimited", () => {
    assert.equal(ConfigSchema.parse({}).max_files, 0);
  });

  it("skips generated files unless review_generated is on", () => {
    const files = [file("src/a.ts", 50), file("dist/bundle.js", 50)];
    assert.equal(selectFiles(files, config()).files.length, 1);
    assert.equal(
      selectFiles(files, config({ review_generated: true })).files.length,
      2,
    );
  });
});
