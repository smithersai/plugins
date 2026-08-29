/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/adapters` — the vendor CLI agents, declared as data.
 *
 * Smithers 1.0 ships one built-in agent. This package is how a run drives
 * somebody else's: Claude Code, Codex, Kimi, or Antigravity, each described by
 * a {@link module:Spec} — the argv its binary takes, how to read a line of its
 * JSON output, which of its messages are quota rather than breakage, and what
 * it can do — with one runner underneath them all.
 *
 * ```ts
 * import { AdapterRuntime, CliRun } from "@smthrs-plugins/adapters"
 * import { Effect } from "effect"
 *
 * const run = Effect.gen(function*() {
 *   const spec = yield* Effect.fromResult(AdapterRuntime.lookup("claude-code"))
 *   return yield* CliRun.run(spec, { prompt: "explain this repository" })
 * })
 * ```
 */

/** Typed adapter failures. */
export * as AdapterError from "./AdapterError.ts"

/** What an adapter declares. */
export * as Spec from "./Spec.ts"

/** Pure command descriptions. */
export * as CommandSpec from "./CommandSpec.ts"

/** Environment projection for a spawned agent. */
export * as Env from "./Env.ts"

/** Vendor output decoding. */
export * as CliOutput from "./CliOutput.ts"

/** Failure classification over vendor output. */
export * as CliClassifier from "./CliClassifier.ts"

/** Capability records and the registry. */
export * as HarnessCapabilities from "./HarnessCapabilities.ts"

/** The system teaching an adapter is given. */
export * as HarnessPrompt from "./HarnessPrompt.ts"

/** Declared output schemas and answer extraction. */
export * as StructuredOutput from "./StructuredOutput.ts"

/** The subprocess runner every adapter shares. */
export * as CliRun from "./CliRun.ts"

/** Adapter lookup. */
export * as AdapterRuntime from "./AdapterRuntime.ts"

/** Readiness reporting for the adapters this package ships. */
export * as Doctor from "./Doctor.ts"

/** Normalized token usage. */
export * as Usage from "./Usage.ts"

/** Per-provider credential locations and reads. */
export * as Credentials from "./Credentials.ts"

/** Claude Code. */
export * as ClaudeCode from "./ClaudeCode.ts"

/** Codex. */
export * as Codex from "./Codex.ts"

/** Kimi. */
export * as Kimi from "./Kimi.ts"

/** Antigravity. */
export * as Antigravity from "./Antigravity.ts"
