/**
 * Print the summary comment for a fixture so the layout can be eyeballed
 * without spending an API call or opening a PR: `npm run preview`.
 */
import { renderSummaryComment } from "./render";

const { body } = renderSummaryComment({
  findings: [
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
  ],
  observations: [
    {
      p: "lib/core/errors/error_mapper.dart",
      l: 23,
      n: "`ErrorMapper.map()` has return type `AppFailure` but throws `SessionExpiredException` for that input. Callers must be aware of this implicit throw contract.",
    },
  ],
  files: [
    { p: "assets/icons/oops.json", k: "asset" },
    { p: "lib/core/errors/app_failure.dart", k: "code", n: 0 },
    { p: "lib/core/errors/error_mapper.dart", k: "code", n: 0 },
    { p: "lib/providers/base_provider.dart", k: "code", n: 0 },
    { p: "lib/providers/sales_tracking_provider.dart", k: "code", n: 2 },
    { p: "pubspec.lock", k: "generated" },
  ],
  assessment:
    "This is a well-structured PR that introduces a clean centralized error handling system. The `sealed class AppFailure` hierarchy, `ErrorMapper` pattern, and `GlobalErrorHandler` singleton with deduplication are well-designed. The two warnings are minor consistency issues in `SalesTrackingProvider`.",
  model: "glm-5.2",
  tokens: 833431,
});

console.log(body);
