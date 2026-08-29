/**
 * Pure environment construction and diagnostic redaction for CLI adapters.
 *
 * Governing contract: `docs/specs/Concepts/Agent Adapters.md`.
 *
 * @since 0.1.0
 */

/**
 * A string-valued environment layer. `undefined` entries are omitted.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = Readonly<Record<string, string | undefined>>

/**
 * Run identity propagated to a spawned CLI and its descendants.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunIdentity {
  readonly runId?: string | undefined
  readonly nodeId?: string | undefined
  readonly iteration?: number | string | undefined
  readonly attempt?: number | string | undefined
}

/**
 * Inputs to pure adapter environment layering.
 *
 * Precedence is: safe process baseline, adapter defaults, resolved
 * credentials, explicitly permitted user overrides, then run identity.
 * Credentials are the sole source allowed to retain conflicting provider API
 * keys, and run identity cannot be spoofed by an adapter or override.
 *
 * @category models
 * @since 0.1.0
 */
export interface Layers {
  readonly processEnv?: Environment | undefined
  readonly runIdentity?: RunIdentity | Environment | undefined
  readonly adapterDefaults?: Environment | undefined
  readonly credentials?: Environment | undefined
  readonly userOverrides?: Environment | undefined
}

const baselineKeys = ["PATH", "HOME", "LANG", "TERM"] as const

const apply = (target: Record<string, string>, layer: Environment | undefined): void => {
  if (layer === undefined) return
  for (const [key, value] of Object.entries(layer)) {
    if (value !== undefined) target[key] = value
  }
}

const defined = (env: object): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )

const identityEnvironment = (identity: RunIdentity | Environment | undefined): Environment => {
  if (identity === undefined) return {}
  if ("runId" in identity || "nodeId" in identity || "iteration" in identity || "attempt" in identity) {
    return {
      ...(identity.runId === undefined || identity.runId.length === 0 ? {} : { FLOWS_RUN_ID: identity.runId }),
      ...(identity.nodeId === undefined || identity.nodeId.length === 0 ? {} : { FLOWS_NODE_ID: identity.nodeId }),
      ...(identity.iteration === undefined || identity.iteration === ""
        ? {}
        : { FLOWS_ITERATION: String(identity.iteration) }),
      ...(identity.attempt === undefined || identity.attempt === "" ? {} : { FLOWS_ATTEMPT: String(identity.attempt) })
    }
  }
  return defined(identity)
}

/**
 * Blanks inherited CLI recursion markers without mutating the input layer.
 *
 * @category utilities
 * @since 0.1.0
 */
export const scrubRecursionMarkers = (env: Environment): Readonly<Record<string, string>> => ({
  ...defined(env),
  CLAUDECODE: "",
  CLAUDE_CODE_ENTRYPOINT: ""
})

/**
 * Blanks provider API keys unless the resolved credential layer supplies them.
 *
 * @category utilities
 * @since 0.1.0
 */
export const blankConflictingKeys = (
  env: Environment,
  credentials: Environment = {}
): Readonly<Record<string, string>> => ({
  ...defined(env),
  ANTHROPIC_API_KEY: credentials.ANTHROPIC_API_KEY ?? "",
  OPENAI_API_KEY: credentials.OPENAI_API_KEY ?? ""
})

/**
 * Produces a hygienic CLI environment using the documented precedence order.
 *
 * Only PATH, HOME, LANG, and TERM can enter from `processEnv`. Recursion
 * markers are always blanked, and provider keys are retained only when the
 * credential layer deliberately supplied them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const merge = (layers: Layers): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {}
  for (const key of baselineKeys) {
    const value = layers.processEnv?.[key]
    if (value !== undefined) environment[key] = value
  }
  apply(environment, layers.adapterDefaults)
  apply(environment, layers.credentials)
  apply(environment, layers.userOverrides)
  apply(environment, identityEnvironment(layers.runIdentity))
  return scrubRecursionMarkers(blankConflictingKeys(environment, layers.credentials))
}

/**
 * Redacts secret-like values before an environment is recorded in diagnostics.
 *
 * @category utilities
 * @since 0.1.0
 */
export const redactForDiagnostics = (env: Environment): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(env).map((
      [key, value]
    ) => [
      key,
      /AUTH|CREDENTIAL|COOKIE|KEY|PASSWORD|SECRET|SESSION|TOKEN/i.test(key) ? "<redacted>" : (value ?? "")
    ])
  )
