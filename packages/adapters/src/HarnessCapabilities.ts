/**
 * Declarative capability records for foreign agent harnesses.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Agent Adapters.md`,
 * `docs/specs/Concepts/Plan.md`, and
 * `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smithers/keys/Digest"
import { CanonicalJson } from "@smithers/model"
import { HashMap, type Option, Schema } from "effect"

/**
 * Supported vendor session-resume mechanisms.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResumeMode = Schema.Literals(["flag", "subcommand", "env", "none"])

/**
 * Supported vendor session-resume mechanisms.
 *
 * @category models
 * @since 0.1.0
 */
export type ResumeMode = typeof ResumeMode.Type

/**
 * Supported MCP bootstrap mechanisms.
 *
 * @category schemas
 * @since 0.1.0
 */
export const McpBootstrapMode = Schema.Literals(["inline-config", "project-config", "none"])

/**
 * Supported MCP bootstrap mechanisms.
 *
 * @category models
 * @since 0.1.0
 */
export type McpBootstrapMode = typeof McpBootstrapMode.Type

/**
 * Supported skill-installation mechanisms.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SkillsInstallMode = Schema.Literals(["plugin-dir", "home-dir", "none"])

/**
 * Supported skill-installation mechanisms.
 *
 * @category models
 * @since 0.1.0
 */
export type SkillsInstallMode = typeof SkillsInstallMode.Type

/**
 * Stable capability declaration for one foreign harness version.
 *
 * @category models
 * @since 0.1.0
 */
export class HarnessCapabilities extends Schema.Class<HarnessCapabilities>(
  "flows/adapters/HarnessCapabilities"
)({
  name: Schema.String,
  version: Schema.String,
  resume: ResumeMode,
  mcpBootstrap: McpBootstrapMode,
  skillsInstall: SkillsInstallMode,
  configDirIsolation: Schema.Boolean,
  nativeStructuredOutput: Schema.Boolean,
  steer: Schema.Boolean,
  images: Schema.Boolean,
  usage: Schema.Boolean
}) {}

/**
 * Immutable registry of harness capability records keyed by harness name.
 *
 * @category models
 * @since 0.1.0
 */
export interface Registry {
  readonly records: HashMap.HashMap<string, HarnessCapabilities>
  readonly multiSeatRecords: HashMap.HashMap<string, HarnessCapabilities>
}

/**
 * Capability material exposed to plan and run cards.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanCardMaterial {
  readonly harness: string
  readonly version: string
  readonly fingerprint: string
  readonly resume: ResumeMode
  readonly mcpBootstrap: McpBootstrapMode
  readonly skillsInstall: SkillsInstallMode
  readonly configDirIsolation: boolean
  readonly nativeStructuredOutput: boolean
  readonly steer: boolean
  readonly images: boolean
  readonly usage: boolean
}

/**
 * Computes a synchronous SHA-256 digest over canonical JSON.
 *
 * @category constructors
 * @since 0.1.0
 */
export const digest = (value: unknown): string => {
  return Digest.digest(CanonicalJson.stringify(value))
}

/**
 * Computes the stable canonical fingerprint of a capability record.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fingerprint = (record: HarnessCapabilities): string =>
  digest({
    configDirIsolation: record.configDirIsolation,
    images: record.images,
    mcpBootstrap: record.mcpBootstrap,
    name: record.name,
    nativeStructuredOutput: record.nativeStructuredOutput,
    resume: record.resume,
    skillsInstall: record.skillsInstall,
    steer: record.steer,
    usage: record.usage,
    version: record.version
  })

/**
 * Tests whether isolated configuration state permits safe multi-seat pooling.
 *
 * @category predicates
 * @since 0.1.0
 */
export const eligibleForMultiSeatPool = (record: HarnessCapabilities): boolean => record.configDirIsolation === true

/**
 * Constructs an immutable capability registry.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeRegistry = (
  records: Iterable<HarnessCapabilities> = []
): Registry => {
  const values = Array.from(records)
  return {
    records: HashMap.fromIterable(values.map((record) => [record.name, record] as const)),
    multiSeatRecords: HashMap.fromIterable(
      values.filter(eligibleForMultiSeatPool).map((record) => [record.name, record] as const)
    )
  }
}

/**
 * Returns a new registry containing the supplied capability record.
 *
 * @category constructors
 * @since 0.1.0
 */
export const register = (
  registry: Registry,
  record: HarnessCapabilities
): Registry => {
  return {
    records: HashMap.set(registry.records, record.name, record),
    multiSeatRecords: record.configDirIsolation
      ? HashMap.set(registry.multiSeatRecords, record.name, record)
      : HashMap.remove(registry.multiSeatRecords, record.name)
  }
}

/**
 * Looks up a capability record by harness name.
 *
 * @category getters
 * @since 0.1.0
 */
export const lookup = (
  registry: Registry,
  name: string
): Option.Option<HarnessCapabilities> => HashMap.get(registry.records, name)

/**
 * Looks up a harness admitted to a multi-seat pool.
 *
 * Non-isolated harnesses are absent from this map by construction, so a pool
 * resolver cannot accidentally admit one by forgetting a predicate.
 *
 * @category getters
 * @since 0.1.0
 */
export const lookupForMultiSeatPool = (
  registry: Registry,
  name: string
): Option.Option<HarnessCapabilities> => HashMap.get(registry.multiSeatRecords, name)

/**
 * Stable layer identities contributed by one foreign-harness dispatch.
 *
 * @category constructors
 * @since 0.1.0
 */
export const keyLayers = (
  record: HarnessCapabilities,
  promptDigest: string,
  projectionDigest: string
): ReadonlyArray<string> =>
  Object.freeze([
    `harness:${record.name}@${record.version}`,
    `harness-capabilities:${fingerprint(record)}`,
    `harness-prompt:${promptDigest}`,
    `harness-projection:${projectionDigest}`
  ])

/**
 * Projects stable capability material for plan and run cards.
 *
 * @category constructors
 * @since 0.1.0
 */
export const planCardMaterial = (
  record: HarnessCapabilities
): PlanCardMaterial => ({
  harness: record.name,
  version: record.version,
  fingerprint: fingerprint(record),
  resume: record.resume,
  mcpBootstrap: record.mcpBootstrap,
  skillsInstall: record.skillsInstall,
  configDirIsolation: record.configDirIsolation,
  nativeStructuredOutput: record.nativeStructuredOutput,
  steer: record.steer,
  images: record.images,
  usage: record.usage
})
