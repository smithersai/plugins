/**
 * @since 0.1.0
 *
 * `@flows/adapters` — declarative CLI harness adapters and reverse projections.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Agent Adapters.md` and
 * `docs/specs/Concepts/Wrapping Adapters.md`.
 */
export { builtInCapabilities, builtInSpecs } from "./AdapterRuntime.ts"

/**
 * @category errors
 * @since 0.1.0
 */
export * as AdapterError from "./AdapterError.ts"

/**
 * @category command construction
 * @since 0.1.0
 */
export * as CommandSpec from "./CommandSpec.ts"

/**
 * @category environment
 * @since 0.1.0
 */
export * as Env from "./Env.ts"

/**
 * @category output
 * @since 0.1.0
 */
export * as CliOutput from "./CliOutput.ts"

/**
 * @category output
 * @since 0.1.0
 */
export * as CliClassifier from "./CliClassifier.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as CliHarness from "./CliHarness.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as AdapterRuntime from "./AdapterRuntime.ts"

/**
 * @category capabilities
 * @since 0.1.0
 */
export * as HarnessCapabilities from "./HarnessCapabilities.ts"

/**
 * @category prompts
 * @since 0.1.0
 */
export * as HarnessPrompt from "./HarnessPrompt.ts"

/**
 * @category output
 * @since 0.1.0
 */
export * as StructuredOutput from "./StructuredOutput.ts"

/**
 * @category projections
 * @since 0.1.0
 */
export * as Projection from "./Projection.ts"

/**
 * @category projections
 * @since 0.1.0
 */
export * as FlowsAsSkills from "./FlowsAsSkills.ts"

/**
 * @category projections
 * @since 0.1.0
 */
export * as FlowsAsMcp from "./FlowsAsMcp.ts"

/**
 * @category MCP
 * @since 0.1.0
 */
export * as Mcp from "./Mcp.ts"

/**
 * @category MCP
 * @since 0.1.0
 */
export * as McpAsWorkflow from "./McpAsWorkflow.ts"

/**
 * @category adapters
 * @since 0.1.0
 */
export * as ClaudeCode from "./ClaudeCode.ts"

/**
 * @category adapters
 * @since 0.1.0
 */
export * as Codex from "./Codex.ts"
