import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { StoredFile, StoredFinding, StoredObservation } from "../types";
import {
  applyIssueCounts,
  buildRoster,
  countBySeverity,
  fileLabel,
  formatCount,
  inferKind,
  mergeRoster,
  renderSummaryComment,
  renderStatusLine,
} from "./render";

const WARNINGS: StoredFinding[] = [
  {
    id: "aaaaaaaa",
    p: "lib/providers/sales_tracking_provider.dart",
    l: 217,
    s: "WARNING",
    t: "Redundant `notifyListeners()` in catch + finally causes double rebuild on every error in `updateRecord`",
  },
  {
    id: "bbbbbbbb",
    p: "lib/providers/sales_tracking_provider.dart",
    l: 346,
    s: "WARNING",
    t: "`confirmReview` missing `on SessionExpiredException` handler unlike all other methods in this provider",
  },
];

const OBSERVATIONS: StoredObservation[] = [
  {
    p: "lib/core/errors/error_mapper.dart",
    l: 23,
    n: "`ErrorMapper.map()` has return type `AppFailure` but throws `SessionExpiredException` for that input.",
  },
];

const FILES: StoredFile[] = [
  { p: "assets/icons/oops.json", k: "asset" },
  { p: "lib/core/errors/app_failure.dart", k: "code", n: 0 },
  { p: "lib/providers/sales_tracking_provider.dart", k: "code", n: 2 },
];

function render(over: Partial<Parameters<typeof renderSummaryComment>[0]> = {}) {
  return renderSummaryComment({
    findings: WARNINGS,
    observations: OBSERVATIONS,
    files: FILES,
    assessment: "Clean centralized error handling.",
    model: "glm-5.2",
    tokens: 833431,
    ...over,
  }).body;
}

describe("renderStatusLine", () => {
  it("reports the recommendation for each severity mix", () => {
    assert.equal(
      renderStatusLine({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 }),
      "**Status:** No Issues Found | **Recommendation:** Approve",
    );
    assert.equal(
      renderStatusLine({ CRITICAL: 0, WARNING: 2, SUGGESTION: 0 }),
      "**Status:** 2 Issues Found | **Recommendation:** Address before merge",
    );
    assert.equal(
      renderStatusLine({ CRITICAL: 1, WARNING: 4, SUGGESTION: 0 }),
      "**Status:** 5 Issues Found | **Recommendation:** Do not merge — critical issues",
    );
    assert.equal(
      renderStatusLine({ CRITICAL: 0, WARNING: 0, SUGGESTION: 1 }),
      "**Status:** 1 Issue Found | **Recommendation:** Safe to merge — suggestions only",
    );
  });
});

describe("renderSummaryComment", () => {
  it("produces the Kilo block", () => {
    const body = render();
    assert.match(body, /^## Code Review Summary\n/);
    assert.ok(
      body.includes(
        "**Status:** 2 Issues Found | **Recommendation:** Address before merge",
      ),
    );
    assert.ok(body.includes("| CRITICAL | 0 |"));
    assert.ok(body.includes("| WARNING | 2 |"));
    assert.ok(body.includes("| SUGGESTION | 0 |"));
    assert.ok(
      body.includes("<summary><b>Issue Details (click to expand)</b></summary>"),
    );
    assert.ok(
      body.includes(
        "<summary><b>Other Observations (not in diff)</b></summary>",
      ),
    );
    assert.ok(body.includes("<summary><b>Files Reviewed (3 files)</b></summary>"));
    assert.ok(body.includes("- `assets/icons/oops.json` - asset file"));
    assert.ok(
      body.includes("- `lib/providers/sales_tracking_provider.dart` - 2 issues"),
    );
    assert.ok(body.includes("- `lib/core/errors/app_failure.dart` - 0 issues"));
    assert.ok(
      body.includes("**Overall Assessment:** Clean centralized error handling."),
    );
    assert.ok(body.endsWith("<sub>Reviewed by glm-5.2 · 833,431 tokens</sub>"));
  });

  it("keeps a blank line after </summary> so GitHub renders the tables", () => {
    assert.ok(render().includes("</summary>\n\n|"));
  });

  it("omits empty sections and the token clause when nothing was spent", () => {
    const body = render({
      findings: [],
      observations: [],
      files: [],
      tokens: 0,
      assessment: "",
    });
    assert.ok(body.includes("**Status:** No Issues Found"));
    assert.ok(!body.includes("Issue Details"));
    assert.ok(!body.includes("Other Observations"));
    assert.ok(!body.includes("Files Reviewed"));
    assert.ok(!body.includes("Overall Assessment"));
    assert.ok(body.endsWith("<sub>Reviewed by glm-5.2</sub>"));
  });

  it("escapes pipes so a title can't shatter the table row", () => {
    const body = render({
      findings: [{ ...WARNINGS[0], t: "use `a | b`\nnot `a || b`" }],
    });
    assert.ok(body.includes("| use `a \\| b` not `a \\|\\| b` |"));
  });

  it("groups issue tables by severity, most severe first", () => {
    const body = render({
      findings: [
        { ...WARNINGS[0], s: "SUGGESTION" },
        { ...WARNINGS[1], s: "CRITICAL" },
      ],
    });
    assert.ok(body.indexOf("#### CRITICAL") < body.indexOf("#### SUGGESTION"));
  });

  it("degrades to fit the budget instead of overflowing", () => {
    const many: StoredFinding[] = Array.from({ length: 400 }, (_, i) => ({
      id: `id${i}`,
      p: `lib/module_${i}/file_${i}.dart`,
      l: i + 1,
      s: "WARNING" as const,
      t: `Finding number ${i} describing a problem in reasonable detail`.repeat(3),
    }));
    const files: StoredFile[] = Array.from({ length: 400 }, (_, i) => ({
      p: `lib/module_${i}/file_${i}.dart`,
      k: "code" as const,
      n: 1,
    }));
    const out = renderSummaryComment(
      {
        findings: many,
        observations: [],
        files,
        assessment: "x",
        model: "glm-5.2",
        tokens: 1,
      },
      20000,
    );
    assert.ok(out.body.length <= 20000, `got ${out.body.length}`);
    assert.notEqual(out.degradation, "none");
    assert.ok(out.dropped > 0);
    // Counts stay truthful even when rows are hidden.
    assert.ok(out.body.includes("| WARNING | 400 |"));
  });
});

describe("roster", () => {
  it("labels dropped files by reason and reviewed files by count", () => {
    const roster = buildRoster(
      ["a.dart", "pkg.lock", "assets/icons/oops.json", "big.dart"],
      new Map([
        ["pkg.lock", "generated" as const],
        ["big.dart", "cap" as const],
      ]),
      new Map([["a.dart", 2]]),
    );
    const label = (p: string) => fileLabel(roster.find((f) => f.p === p)!);
    assert.equal(label("a.dart"), "2 issues");
    assert.equal(label("pkg.lock"), "generated file");
    assert.equal(label("big.dart"), "not reviewed (max_files)");
    assert.equal(label("assets/icons/oops.json"), "asset file");
  });

  it("recomputes counts from findings rather than summing across runs", () => {
    const merged = mergeRoster(
      [{ p: "a.dart", k: "code", n: 1 }],
      [{ p: "a.dart", k: "code", n: 1 }],
    );
    const applied = applyIssueCounts(merged, [
      { id: "x", p: "a.dart", l: 1, s: "WARNING", t: "t" },
    ]);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].n, 1);
  });

  it("keeps files from earlier runs that this run did not touch", () => {
    const merged = mergeRoster(
      [{ p: "old.dart", k: "code", n: 0 }],
      [{ p: "new.dart", k: "code", n: 1 }],
    );
    assert.deepEqual(
      merged.map((f) => f.p).sort(),
      ["new.dart", "old.dart"],
    );
  });

  it("infers asset and generated kinds from the path", () => {
    assert.equal(inferKind("assets/icons/oops.json"), "asset");
    assert.equal(inferKind("web/logo.svg"), "asset");
    assert.equal(inferKind("lib/model.g.dart"), "generated");
    assert.equal(inferKind("lib/providers/thing.dart"), "code");
  });
});

describe("helpers", () => {
  it("counts by severity", () => {
    assert.deepEqual(countBySeverity(WARNINGS), {
      CRITICAL: 0,
      WARNING: 2,
      SUGGESTION: 0,
    });
  });

  it("formats counts without depending on ICU", () => {
    assert.equal(formatCount(833431), "833,431");
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(999), "999");
    assert.equal(formatCount(1000), "1,000");
  });
});
