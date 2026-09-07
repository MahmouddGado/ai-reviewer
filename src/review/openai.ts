import Anthropic from "@anthropic-ai/sdk";
import { REVIEW_TOOL_SCHEMA } from "../types";

/** OpenAI-compatible transport for z.ai accounts restricted to the Coding endpoint. */
export async function callOpenAI(
  apiKey: string, baseURL: string, model: string, maxTokens: number,
  system: string, messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  const converted: object[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      converted.push({ role: message.role, content: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_use") {
        converted.push({ role: "assistant", content: null, tool_calls: [{
          id: block.id, type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }] });
      } else if (block.type === "tool_result") {
        converted.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
      } else if (block.type === "text") {
        converted.push({ role: message.role, content: block.text });
      }
    }
  }
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(600000),
    body: JSON.stringify({
      model, max_tokens: maxTokens, messages: converted,
      tools: [{ type: "function", function: { name: "submit_review", description: "Submit the structured review", parameters: REVIEW_TOOL_SCHEMA } }],
      tool_choice: "auto",
    }),
  });
  if (!response.ok) throw new Error(`Model API returned HTTP ${response.status}; check the API key, model access, and base_url.`);
  const data = await response.json() as {
    choices?: { finish_reason?: string; message?: { tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const choice = data.choices?.[0];
  const content: Anthropic.ToolUseBlock[] = (choice?.message?.tool_calls ?? []).map((call) => ({
    type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments),
  }));
  const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = {
    input_tokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
    output_tokens: data.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
  return {
    id: "openai-review", type: "message", role: "assistant", model, content,
    stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "tool_use",
    stop_sequence: null,
    usage,
  };
}
