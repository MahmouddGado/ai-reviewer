import * as core from "@actions/core";
import Anthropic from "@anthropic-ai/sdk";
import {
  REVIEW_TOOL_SCHEMA,
  ReviewResult,
  ReviewResultSchema,
} from "../types";

const TOOL_NAME = "submit_review";

export class ReviewEngine {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model: string,
    baseURL?: string,
  ) {
    // baseURL points the Anthropic SDK at z.ai's Anthropic-compatible endpoint
    // (https://api.z.ai/api/anthropic) so GLM models work with no code changes.
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async review(system: string, user: string): Promise<ReviewResult> {
    return this.call(system, [{ role: "user", content: user }]);
  }

  /** Second pass: feed the draft result back for false-positive pruning. */
  async verify(
    system: string,
    user: string,
    draft: ReviewResult,
  ): Promise<ReviewResult> {
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
            content: "Now verify and resubmit only the findings that survive.",
          },
        ],
      },
    ]);
  }

  private async call(
    system: string,
    messages: Anthropic.MessageParam[],
  ): Promise<ReviewResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      system,
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Submit the structured code review (walkthrough, changed files, and line-anchored findings).",
          input_schema: REVIEW_TOOL_SCHEMA as any,
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages,
    });

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("Model did not return a submit_review tool call.");
    }

    const parsed = ReviewResultSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      core.warning(
        `Model output failed validation: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
      // Best-effort salvage: coerce with defaults.
      return ReviewResultSchema.parse({
        walkthrough:
          (toolUse.input as any)?.walkthrough ?? "Review completed.",
        changed_files: (toolUse.input as any)?.changed_files ?? [],
        findings: [],
      });
    }
    return parsed.data;
  }
}
