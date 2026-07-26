import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Configuration schema (.aireviewer.yaml)                             *
 * ------------------------------------------------------------------ */

export const PathInstructionSchema = z.object({
  path: z.string(),
  instructions: z.string().max(20000),
});

export const AutoReviewSchema = z.object({
  enabled: z.boolean().default(true),
  drafts: z.boolean().default(false),
  base_branches: z.array(z.string()).default(["main", "master"]),
  ignore_title_keywords: z.array(z.string()).default(["WIP", "[skip review]"]),
});

export const ConfigSchema = z.object({
  profile: z.enum(["quiet", "chill", "assertive"]).default("chill"),
  /** 0 = review every changed file, however many there are. */
  max_files: z.number().int().nonnegative().default(0),
  /**
   * Chars of rendered diff per model request. Files are split across as many
   * requests as needed, so this bounds each call — never how much gets reviewed.
   */
  batch_chars: z.number().int().positive().default(200000),
  /** Review lock files, minified bundles, `dist/`, snapshots — off by default. */
  review_generated: z.boolean().default(false),
  auto_review: AutoReviewSchema.default({}),
  path_filters: z.array(z.string()).default([]),
  path_instructions: z.array(PathInstructionSchema).default([]),
  verification: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PathInstruction = z.infer<typeof PathInstructionSchema>;

/* ------------------------------------------------------------------ *
 * Structured review output (returned by the model via tool use)       *
 * ------------------------------------------------------------------ */

/** Rendered verbatim in the summary table and as the inline-comment label. */
export const SEVERITIES = ["CRITICAL", "WARNING", "SUGGESTION"] as const;
export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "style",
  "test",
  "docs",
  "other",
] as const;

export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  /** Short label — renders straight after `**WARNING:**` on the inline comment. */
  title: z.string(),
  /** One-line problem + consequence — renders as the `Issue` cell in the summary table. */
  summary: z.string(),
  /** The full explanation: symbols involved, failure path, consequence. */
  body: z.string(),
  suggestion: z.string().optional(),
});

/** Something real the model noticed that isn't anchored to a changed line. */
export const ObservationSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  note: z.string(),
});

export const ReviewResultSchema = z.object({
  overall_assessment: z.string().default(""),
  findings: z.array(FindingSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/* ------------------------------------------------------------------ *
 * Accumulated per-PR state (persisted in the hidden summary marker)   *
 * ------------------------------------------------------------------ */

/** Why a changed file is (or isn't) annotated with an issue count in the roster. */
export type FileKind =
  | "code" // reviewed
  | "asset"
  | "generated"
  | "filtered" // excluded by the user's path_filters
  | "cap" // over max_files
  | "binary"
  | "deleted";

/** Keys are short because this is serialised into a comment body with a 65,536-char cap. */
export interface StoredFinding {
  id: string; // findingId() — stable across line drift
  p: string; // path
  l: number; // line, refreshed from GitHub on every run
  s: Severity;
  t: string; // `summary`, truncated
  c?: number; // id of the review comment carrying it
}

export interface StoredObservation {
  p: string;
  l?: number;
  n: string; // note, truncated
}

export interface StoredFile {
  p: string;
  k: FileKind;
  n?: number; // issue count, `code` files only
}

/* The JSON Schema handed to the model as a tool. Kept in sync with the zod
 * schema above by hand (small enough not to warrant a generator). */
export const REVIEW_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    overall_assessment: {
      type: "string",
      description:
        "2-5 sentences judging the change as a whole: name the patterns it introduces, say whether the design is sound, and end by characterising what the issues (if any) amount to.",
    },
    findings: {
      type: "array",
      description: "Line-anchored review findings. Empty if the code is clean.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path." },
          line: {
            type: "integer",
            description:
              "The line number in the NEW version of the file (RIGHT side of the diff). Must be a line shown in the provided diff.",
          },
          end_line: {
            type: "integer",
            description:
              "For a multi-line finding, the last line. Omit for single-line findings.",
          },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: {
            type: "string",
            description:
              "Short noun-phrase label, at most ~8 words, e.g. 'Missing `on SessionExpiredException` handler'. Not a sentence.",
          },
          summary: {
            type: "string",
            description:
              "One line naming the problem AND its consequence, e.g. 'Redundant `notifyListeners()` in catch + finally causes double rebuild on every error in `updateRecord`'. Rendered in a markdown table cell, so keep it to one line.",
          },
          body: {
            type: "string",
            description:
              "The full explanation. Name the concrete symbols involved, trace the actual failure path step by step, and state the consequence. Contrast with sibling code when the issue is an inconsistency.",
          },
          suggestion: {
            type: "string",
            description:
              "Optional. Replacement code for lines [line..end_line]. Provide ONLY the replacement lines, no fences. Used to render a committable suggestion. Omit unless the fix is mechanical and you are confident it compiles.",
          },
        },
        required: [
          "path",
          "line",
          "severity",
          "category",
          "title",
          "summary",
          "body",
        ],
      },
    },
    observations: {
      type: "array",
      description:
        "Real things you noticed in surrounding or unchanged code that are NOT anchored to a changed line. Never repeat a finding here.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          note: {
            type: "string",
            description:
              "What you noticed and why it matters. One paragraph; rendered in a table cell.",
          },
        },
        required: ["path", "note"],
      },
    },
  },
  required: ["overall_assessment", "findings"],
};
