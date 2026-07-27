import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DiffFile } from "../github/diff";
import { DEFAULT_STATE, ReviewState } from "../github/state";
import { ExistingComments } from "../github/review";
import {
  priorFindingAliases,
  priorFindingsForBatch,
  withRenamedPaths,
  withoutPaths,
} from "./orchestrator";

const FILE: DiffFile = {
  path: "src/new-name.ts",
  oldPath: "src/old-name.ts",
  isDeleted: false,
  isBinary: false,
  commentableLines: new Set([18]),
  rendered: "",
  additions: 1,
  deletions: 1,
};

describe("incremental orchestration helpers", () => {
  it("selects prior findings for the batch and refreshes live lines", () => {
    const findings = [
      {
        id: "keep",
        p: "src/old-name.ts",
        l: 12,
        s: "WARNING" as const,
        t: "The retry loop can run forever.",
      },
      {
        id: "other",
        p: "src/other.ts",
        l: 4,
        s: "CRITICAL" as const,
        t: "Other",
      },
    ];
    const existing: ExistingComments = {
      byId: new Map([
        [
          "keep",
          {
            commentId: 7,
            line: 18,
            outdated: false,
            title: "Retry remains unbounded",
          },
        ],
      ]),
      legacy: new Set(),
    };

    const contexts = priorFindingsForBatch([FILE], findings, existing);

    assert.equal(contexts.length, 1);
    assert.deepEqual(
      contexts[0],
      {
        id: "keep",
        path: "src/new-name.ts",
        line: 18,
        severity: "WARNING",
        title: "Retry remains unbounded",
        summary: "The retry loop can run forever.",
      },
    );
  });

  it("keeps a prior finding id when its file is renamed", () => {
    const aliases = priorFindingAliases(
      [
        {
          path: "src/new-name.ts",
          line: 18,
          severity: "WARNING",
          category: "bug",
          title: "Retry remains unbounded",
          summary: "The retry loop can run forever.",
          body: "The retry loop still has no upper bound.",
        },
      ],
      [
        {
          id: "old-path-id",
          path: "src/new-name.ts",
          line: 18,
          severity: "WARNING",
          title: "Retry remains unbounded",
          summary: "The retry loop can run forever.",
        },
      ],
    );

    assert.deepEqual([...aliases.values()], ["old-path-id"]);
  });

  it("moves persisted review state to a renamed path", () => {
    const state: ReviewState = {
      ...DEFAULT_STATE,
      findings: [
        { id: "move", p: "old.ts", l: 1, s: "WARNING", t: "move" },
      ],
      observations: [{ p: "old.ts", n: "move" }],
      files: [{ p: "old.ts", k: "code", n: 1 }],
    };

    const next = withRenamedPaths(state, new Map([["old.ts", "new.ts"]]));

    assert.equal(next.findings[0].p, "new.ts");
    assert.equal(next.observations[0].p, "new.ts");
    assert.equal(next.files[0].p, "new.ts");
  });

  it("removes persisted review state for deleted paths", () => {
    const state: ReviewState = {
      ...DEFAULT_STATE,
      findings: [
        { id: "drop", p: "gone.ts", l: 1, s: "WARNING", t: "gone" },
        { id: "keep", p: "stay.ts", l: 2, s: "WARNING", t: "stay" },
      ],
      observations: [
        { p: "gone.ts", n: "gone" },
        { p: "stay.ts", n: "stay" },
      ],
      files: [
        { p: "gone.ts", k: "code", n: 1 },
        { p: "stay.ts", k: "code", n: 1 },
      ],
    };

    const next = withoutPaths(state, new Set(["gone.ts"]));

    assert.deepEqual(next.findings.map((finding) => finding.p), ["stay.ts"]);
    assert.deepEqual(next.observations.map((note) => note.p), ["stay.ts"]);
    assert.deepEqual(next.files.map((file) => file.p), ["stay.ts"]);
  });
});
