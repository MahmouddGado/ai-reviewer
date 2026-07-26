import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Config, ConfigSchema } from "../types";
import { DiffFile } from "../github/diff";
import { planBatches } from "./batch";
import { selectFiles } from "./chunker";

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

  it("gives an oversized file its own batch rather than truncating it", () => {
    const files = [file("small.ts", 100), file("huge.ts", 50000)];
    const batches = planBatches(files, 5000);
    const huge = batches.find((b) => b.some((f) => f.path === "huge.ts"));
    assert.ok(huge);
    assert.equal(huge!.length, 1);
    assert.equal(huge![0].rendered.length, 50000, "content must be intact");
    // and the small file is still reviewed
    assert.ok(batches.flat().some((f) => f.path === "small.ts"));
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
