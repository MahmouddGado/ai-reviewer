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
  max_files: z.number().int().positive().default(50),
  auto_review: AutoReviewSchema.default({}),
  path_filters: z.array(z.string()).default([]),
  path_instructions: z.array(PathInstructionSchema).default([]),
  verification: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PathInstruction = z.infer<typeof PathInstructionSchema>;

/* ------------------------------------------------------------------ *
 * Structured review output (returned by Claude via tool use)          *
 * ------------------------------------------------------------------ */

export const SEVERITIES = ["potential_issue", "refactor", "nitpick"] as const;
export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "style",
  "test",
  "docs",
  "other",
] as const;

export const FindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
});

export const ChangedFileSchema = z.object({
  path: z.string(),
  summary: z.string(),
});

export const ReviewResultSchema = z.object({
  walkthrough: z.string(),
  changed_files: z.array(ChangedFileSchema).default([]),
  findings: z.array(FindingSchema).default([]),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ChangedFile = z.infer<typeof ChangedFileSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/* The JSON Schema handed to Claude as a tool. Kept in sync with the zod
 * schema above by hand (small enough not to warrant a generator). */
export const REVIEW_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    walkthrough: {
      type: "string",
      description:
        "A concise markdown summary of what this PR does and why, as the author would explain it.",
    },
    changed_files: {
      type: "array",
      description: "One short entry per meaningfully-changed file.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          summary: { type: "string" },
        },
        required: ["path", "summary"],
      },
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
          title: { type: "string", description: "Short one-line summary." },
          body: {
            type: "string",
            description: "Explanation of the problem and why it matters.",
          },
          suggestion: {
            type: "string",
            description:
              "Optional. Replacement code for lines [line..end_line]. Provide ONLY the replacement lines, no fences. Used to render a committable suggestion.",
          },
        },
        required: ["path", "line", "severity", "category", "title", "body"],
      },
    },
  },
  required: ["walkthrough", "findings"],
};
