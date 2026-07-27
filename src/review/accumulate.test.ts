import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Finding, StoredFinding } from "../types";
import {
  buildInlineComments,
  extractAirId,
  extractLegacyTitle,
  findingId,
  renderFindingBody,
} from "../github/review";
import { DiffFile } from "../github/diff";
import {
  CommentStatus,
  capFindings,
  dropObservationsWithComments,
  mergeFindings,
  mergeObservations,
  toStoredFinding,
} from "./accumulate";

const FINDING: Finding = {
  path: "lib/providers/sales_tracking_provider.dart",
  line: 346,
  severity: "WARNING",
  category: "bug",
  title: "Missing `on SessionExpiredException` handler",
  summary: "`confirmReview` lacks the handler every sibling method has",
  body: "`confirmReview` catches `on AppFailure` and `catch (e, st)` but does not handle `on SessionExpiredException` explicitly.",
};

function diffFile(path: string, lines: number[]): DiffFile {
  return {
    path,
    oldPath: path,
    isDeleted: false,
    isBinary: false,
    commentableLines: new Set(lines),
    rendered: "",
    additions: lines.length,
    deletions: 0,
  };
}

const NO_EXISTING = { byId: new Map(), legacy: new Set<string>() };

describe("inline comment body", () => {
  it("uses the Kilo header shape with no emoji", () => {
    const body = renderFindingBody(FINDING);
    const lines = body.split("\n");
    assert.equal(
      lines[0],
      "**WARNING:** Missing `on SessionExpiredException` handler",
    );
    assert.equal(lines[1], "");
    assert.ok(!/[⛔⚠️🔹]/.test(body));
    assert.ok(!body.includes("_bug_"));
  });

  it("appends a committable suggestion only when one is supplied", () => {
    assert.ok(!renderFindingBody(FINDING).includes("```suggestion"));
    const withFix = renderFindingBody({
      ...FINDING,
      suggestion: "    } on SessionExpiredException {\n      rethrow;",
    });
    assert.ok(
      withFix.includes(
        "```suggestion\n    } on SessionExpiredException {\n      rethrow;\n```",
      ),
    );
  });

  it("round-trips its id, which is what makes dedup work", () => {
    const body = renderFindingBody(FINDING);
    assert.equal(extractAirId(body), findingId(FINDING.path, FINDING.title));
  });

  it("gives the same id after the finding drifts to another line", () => {
    assert.equal(
      findingId(FINDING.path, FINDING.title),
      findingId(FINDING.path, "Missing `on SessionExpiredException` handler."),
    );
  });

  it("still recovers titles from comments written by older builds", () => {
    assert.equal(
      extractLegacyTitle("⛔ **Potential issue** · _bug_\n\n**Old title**\n\nbody"),
      "Old title",
    );
    assert.equal(
      extractLegacyTitle("**WARNING:** Kilo-era title\n\nbody"),
      "Kilo-era title",
    );
  });
});

describe("buildInlineComments", () => {
  const files = [diffFile(FINDING.path, [346])];

  it("posts a finding anchored to a changed line", () => {
    const out = buildInlineComments([FINDING], files, NO_EXISTING);
    assert.equal(out.comments.length, 1);
    assert.equal(out.comments[0].line, 346);
    assert.equal(out.unanchored.length, 0);
  });

  it("demotes a finding on an unchanged line instead of dropping it", () => {
    const out = buildInlineComments(
      [{ ...FINDING, line: 999 }],
      files,
      NO_EXISTING,
    );
    assert.equal(out.comments.length, 0);
    assert.equal(out.unanchored.length, 1);
  });

  it("skips a finding that already has a comment", () => {
    const existing = {
      byId: new Map<string, CommentStatus>([
        [
          findingId(FINDING.path, FINDING.title),
          { commentId: 1, line: 346, outdated: false },
        ],
      ]),
      legacy: new Set<string>(),
    };
    const out = buildInlineComments([FINDING], files, existing);
    assert.equal(out.comments.length, 0);
    assert.equal(out.duplicates.length, 1);
  });

  it("refreshes a finding whose previous comment is outdated", () => {
    const existing = {
      byId: new Map<string, CommentStatus>([
        [
          findingId(FINDING.path, FINDING.title),
          { commentId: 1, line: 346, outdated: true },
        ],
      ]),
      legacy: new Set<string>(),
    };
    const out = buildInlineComments([FINDING], files, existing);

    assert.equal(out.comments.length, 1);
    assert.equal(out.duplicates.length, 0);
  });

  it("uses a prior id when refreshing a finding after a rename", () => {
    const priorId = findingId("src/old-name.ts", FINDING.title);
    const renamed = { ...FINDING, path: "src/new-name.ts" };
    const out = buildInlineComments(
      [renamed],
      [diffFile(renamed.path, [renamed.line])],
      NO_EXISTING,
      new Map([[findingId(renamed.path, renamed.title), priorId]]),
    );

    assert.equal(out.comments.length, 1);
    assert.equal(extractAirId(out.comments[0].body), priorId);
  });

  it("does not post the same finding twice within one run", () => {
    const out = buildInlineComments([FINDING, FINDING], files, NO_EXISTING);
    assert.equal(out.comments.length, 1);
    assert.equal(out.duplicates.length, 1);
  });
});

describe("mergeFindings", () => {
  const stored = toStoredFinding(FINDING);

  it("carries findings forward across commits", () => {
    const { findings } = mergeFindings([stored], [], new Map());
    assert.equal(findings.length, 1);
    assert.equal(findings[0].h, FINDING.title);
  });

  it("keeps an outdated finding without a resolved verdict", () => {
    const tracked = new Map<string, CommentStatus>([
      [stored.id, { commentId: 7, line: 346, outdated: true }],
    ]);
    const { findings, expired } = mergeFindings([stored], [], tracked);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].c, undefined);
    assert.equal(expired.length, 0);
  });

  it("removes a finding only after an explicit resolved verdict", () => {
    const tracked = new Map<string, CommentStatus>([
      [stored.id, { commentId: 7, line: 346, outdated: false }],
    ]);
    const { findings, expired } = mergeFindings(
      [stored],
      [],
      tracked,
      [
        { id: stored.id, status: "resolved", reason: "The guard was added." },
      ],
    );
    assert.equal(findings.length, 0);
    assert.equal(expired.length, 1);
  });

  it("keeps a finding when reconciliation verdicts conflict", () => {
    const { findings, expired } = mergeFindings(
      [stored],
      [],
      new Map(),
      [
        { id: stored.id, status: "resolved", reason: "Looks fixed." },
        { id: stored.id, status: "unknown", reason: "Context is incomplete." },
      ],
    );
    assert.equal(findings.length, 1);
    assert.equal(expired.length, 0);
  });

  it("refreshes the line number as later commits shift the code", () => {
    const tracked = new Map<string, CommentStatus>([
      [stored.id, { commentId: 7, line: 372, outdated: false }],
    ]);
    const { findings } = mergeFindings([stored], [], tracked);
    assert.equal(findings[0].l, 372);
    assert.equal(findings[0].c, 7);
  });

  it("does not duplicate a finding the model re-reports on a later run", () => {
    const drifted = toStoredFinding({ ...FINDING, line: 372 });
    const { findings, expired } = mergeFindings(
      [stored],
      [drifted],
      new Map(),
      [
        { id: stored.id, status: "resolved", reason: "Incorrect draft verdict." },
      ],
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].l, 372);
    assert.equal(expired.length, 0);
  });

  it("never evicts a CRITICAL to make room for a SUGGESTION", () => {
    const many: StoredFinding[] = [
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `s${i}`,
        p: "a.dart",
        l: i,
        s: "SUGGESTION" as const,
        t: "t",
      })),
      { id: "crit", p: "a.dart", l: 1, s: "CRITICAL" as const, t: "boom" },
    ];
    const capped = capFindings(many);
    assert.equal(capped.length, 200);
    assert.ok(capped.some((f) => f.id === "crit"));
  });
});

describe("observations", () => {
  it("drops a stale observation once its file is re-reviewed", () => {
    const prev = [{ p: "lib/a.dart", l: 23, n: "old note" }];
    const merged = mergeObservations(prev, [], new Set(["lib/a.dart"]));
    assert.equal(merged.length, 0);
  });

  it("keeps an observation about a file this run did not touch", () => {
    const prev = [{ p: "lib/a.dart", l: 23, n: "old note" }];
    const merged = mergeObservations(prev, [], new Set(["lib/b.dart"]));
    assert.equal(merged.length, 1);
  });

  it("does not repeat something already posted as an inline comment", () => {
    const observations = [{ p: "lib/a.dart", l: 10, n: "same thing" }];
    const findings: StoredFinding[] = [
      { id: "x", p: "lib/a.dart", l: 10, s: "WARNING", t: "same thing" },
    ];
    assert.equal(
      dropObservationsWithComments(observations, findings).length,
      0,
    );
  });
});
