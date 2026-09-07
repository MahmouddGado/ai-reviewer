import { strict as assert } from "node:assert";
import { it } from "node:test";
import { ReviewEngine } from "./engine";
import { ReviewResultSchema } from "../types";

it("uses GLM-5.3 through OpenAI for review and verification, preserving usage and truncation", async (t) => {
  const requests: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
    requests.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({
      choices: [{ finish_reason: requests.length === 1 ? "tool_calls" : "length", message: { tool_calls: [{ id: "call", function: { name: "submit_review", arguments: JSON.stringify({ findings: [] }) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
    }), { status: 200 });
  });
  const engine = new ReviewEngine("test-key", "glm-5.3", "https://api.z.ai/api/coding/paas/v4", 32000, "openai");
  const review = await engine.review("system", "diff");
  assert.deepEqual(review.usage, { input: 70, output: 20, cached: 30 });
  assert.equal(review.incomplete, false);
  const verified = await engine.verify("verify", "diff", ReviewResultSchema.parse({}));
  assert.equal(verified.incomplete, true);
  assert.equal(requests[0].model, "glm-5.3");
  assert.equal(requests[1].messages[2].tool_calls[0].function.name, "submit_review");
  assert.equal(requests[1].messages[3].tool_call_id, "draft");
});

it("rejects a missing structured review instead of treating it as clean", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "No issues" } }] })));
  const engine = new ReviewEngine("test-key", "glm-5.3", undefined, 32000, "openai");
  await assert.rejects(engine.review("system", "diff"), /submit_review/);
});
