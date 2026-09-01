/**
 * Print the summary comment for a fixture so the layout can be eyeballed
 * without spending an API call or opening a PR: `npm run preview`.
 */
import { renderSummaryComment } from "./render";

const { body } = renderSummaryComment({
  findings: [],
  observations: [],
  files: [
    {
      p: "lib/payment_notifier.dart",
      k: "code",
      n: 0,
      r: "clean; previous stale-id finding verified fixed",
    },
    {
      p: "test/payment_notifier_test.dart",
      k: "code",
      n: 0,
      r: "clean; regression test pins cancel → restart behavior",
    },
  ],
  assessment: "",
  model: "glm-5.2",
  usage: { input: 29000, output: 7300, cached: 302500 },
  commit: "004a79e123",
  scope: "incremental",
  history: [
    {
      sha: "b364bc6123",
      scope: "incremental",
      findings: [
        {
          id: "aaaaaaaa",
          p: "lib/payment_notifier.dart",
          l: 217,
          s: "WARNING",
          t: "A stale payment id can survive into the next attempt and corroborate the wrong result",
        },
      ],
      observations: [],
      files: [
        { p: "lib/payment_notifier.dart", k: "code", n: 1 },
        { p: "test/payment_notifier_test.dart", k: "code", n: 0 },
      ],
    },
  ],
});

console.log(body);
