import * as core from "@actions/core";
import Anthropic from "@anthropic-ai/sdk";
import {
  FileReviewSchema,
  FindingSchema,
  PriorFindingVerdictSchema,
  REVIEW_TOOL_SCHEMA,
  ReviewResult,
  ReviewResultSchema,
} from "../types";

const TOOL_NAME = "submit_review";

/**
 * Dense finding bodies plus observations plus the assessment outgrow 8k fast,
 * and a batch of large files can carry dozens of findings. Overridable via the
 * `max_output_tokens` input for models with a smaller ceiling.
 */
const DEFAULT_MAX_TOKENS = 32000;

export interface CallUsage {
  input: number;
  output: number;
  cached: number;
}

export interface EngineResult {
  result: ReviewResult;
  usage: CallUsage;
}

export class ReviewEngine {
  private client: Anthropic;
  private maxTokens: number;
  constructor(
    apiKey: string,
    public readonly model: string,
    baseURL?: string,
    maxTokens?: number,
  ) {
    // baseURL points the Anthropic SDK at z.ai's Anthropic-compatible endpoint
    // (https://api.z.ai/api/anthropic) so GLM models work with no code changes.
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.maxTokens =
      maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
  }

  async review(system: string, user: string): Promise<EngineResult> {
    return this.call(system, [{ role: "user", content: user }]);
  }

  /** Second pass: feed the draft result back for false-positive pruning. */
  async verify(
    system: string,
    user: string,
    draft: ReviewResult,
  ): Promise<EngineResult> {
    return this.call(system, [
      { role: "user", content: user },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "draft",
            name: TOOL_NAME,
            input: draft as unknown as Record<string, unknown>,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "draft",
            content:
              "Now verify the findings and prior-finding verdicts, then resubmit the complete result.",
          },
        ],
      },
    ]);
  }

  private async call(
    system: string,
    messages: Anthropic.MessageParam[],
  ): Promise<EngineResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Submit the structured code review, including prior-finding reconciliation when prior findings were supplied.",
          input_schema: REVIEW_TOOL_SCHEMA as any,
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages,
    });

    const usage = readUsage(response);

    if (response.stop_reason === "max_tokens") {
      core.warning(
        `Model hit the ${this.maxTokens}-token output cap; this batch's review may be incomplete. Consider lowering batch_chars so each request carries fewer files.`,
      );
    }

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("Model did not return a submit_review tool call.");
    }

    const parsed = ReviewResultSchema.safeParse(toolUse.input);
    if (parsed.success) return { result: parsed.data, usage };

    core.warning(
      `Model output failed validation: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
    return { result: salvage(toolUse.input), usage };
  }
}

/**
 * A truncated or malformed tool call used to be discarded wholesale, which
 * reported a clean PR when the model had actually found problems. Keep every
 * finding that validates individually and drop only the ones that don't.
 */
function salvage(input: unknown): ReviewResult {
  const raw = (input ?? {}) as Record<string, unknown>;
  const findings = Array.isArray(raw.findings)
    ? raw.findings.flatMap((f) => {
        const one = FindingSchema.safeParse(f);
        return one.success ? [one.data] : [];
      })
    : [];
  const priorVerdicts = Array.isArray(raw.prior_finding_verdicts)
    ? raw.prior_finding_verdicts.flatMap((v) => {
        const one = PriorFindingVerdictSchema.safeParse(v);
        return one.success ? [one.data] : [];
      })
    : [];
  const fileReviews = Array.isArray(raw.file_reviews)
    ? raw.file_reviews.flatMap((review) => {
        const one = FileReviewSchema.safeParse(review);
        return one.success ? [one.data] : [];
      })
    : [];

  if (findings.length > 0 || priorVerdicts.length > 0) {
    core.warning(
      `Salvaged ${findings.length} finding(s) and ${priorVerdicts.length} prior verdict(s) from a partial response.`,
    );
  }

  return ReviewResultSchema.parse({
    overall_assessment:
      typeof raw.overall_assessment === "string" ? raw.overall_assessment : "",
    findings,
    observations: [],
    file_reviews: fileReviews,
    prior_finding_verdicts: priorVerdicts,
  });
}

/**
 * z.ai's Anthropic-compatible endpoint doesn't always populate the cache fields,
 * so every component is read defensively and the total may legitimately be 0.
 */
function readUsage(response: Anthropic.Message): CallUsage {
  const u = (response as any).usage ?? {};
  const input =
    num(u.input_tokens);
  const output = num(u.output_tokens);
  const cached =
    num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  return { input, output, cached };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
