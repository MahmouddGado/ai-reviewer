import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_STATE, encodeState, parseState, ReviewState } from "./state";

const STATE: ReviewState = {
  ...DEFAULT_STATE,
  lastReviewedSha: "abc1234",
  reviewCount: 3,
  tokens: 833431,
  model: "glm-5.2",
  assessment: "Sound design.",
  findings: [
    { id: "aaaaaaaa", p: "lib/a.dart", l: 217, s: "WARNING", t: "double rebuild" },
  ],
  observations: [{ p: "lib/b.dart", l: 23, n: "implicit throw contract" }],
  files: [{ p: "lib/a.dart", k: "code", n: 1 }],
};

describe("state marker", () => {
  it("round-trips through the encoded marker", () => {
    const parsed = parseState(`preamble\n${encodeState(STATE)}\ntrailer`);
    assert.deepEqual(parsed, STATE);
  });

  it("survives a finding whose text would close an HTML comment", () => {
    const nasty: ReviewState = {
      ...STATE,
      findings: [
        {
          id: "cccccccc",
          p: "lib/c.dart",
          l: 1,
          s: "CRITICAL",
          t: "`a --> b` inside <!-- a comment --> breaks parsing",
        },
      ],
    };
    const marker = encodeState(nasty);
    // Nothing that could terminate the comment early leaks into the marker.
    assert.equal(marker.indexOf("-->"), marker.length - 3);
    assert.deepEqual(parseState(marker), nasty);
  });

  it("migrates a v1 marker so the PR keeps its incremental position", () => {
    const v1 = `<!-- AI-REVIEWER-STATE {"lastReviewedSha":"deadbee","reviewCount":2,"paused":true} -->`;
    const parsed = parseState(v1)!;
    assert.equal(parsed.v, 2);
    assert.equal(parsed.lastReviewedSha, "deadbee");
    assert.equal(parsed.reviewCount, 2);
    assert.equal(parsed.paused, true);
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.tokens, 0);
  });

  it("returns null when there is no marker at all", () => {
    assert.equal(parseState("just a normal comment"), null);
    assert.equal(parseState(undefined), null);
  });

  it("stays well inside GitHub's comment limit at realistic scale", () => {
    const big: ReviewState = {
      ...STATE,
      findings: Array.from({ length: 200 }, (_, i) => ({
        id: `id${i}`.padEnd(8, "0"),
        p: `lib/module_${i}/file_${i}.dart`,
        l: i,
        s: "WARNING" as const,
        t: "A reasonably long one-line description of the problem and its consequence".slice(0, 300),
      })),
      files: Array.from({ length: 300 }, (_, i) => ({
        p: `lib/module_${i}/file_${i}.dart`,
        k: "code" as const,
        n: 1,
      })),
    };
    assert.ok(encodeState(big).length < 20000, `${encodeState(big).length}`);
  });
});
