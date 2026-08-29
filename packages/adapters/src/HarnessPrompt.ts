/**
 * Deterministic system-channel assembly for foreign agent harnesses.
 *
 * Governing contract: `docs/specs/Concepts/System Prompt.md`.
 *
 * @since 0.1.0
 */
import type { HarnessCapabilities } from "./HarnessCapabilities.ts"
import { digest } from "./HarnessCapabilities.ts"
import type * as StructuredOutput from "./StructuredOutput.ts"
import { renderSchema } from "./StructuredOutput.ts"

/**
 * Adapter-owned system prompt sections.
 *
 * Sections are rendered in contract order. The output-row contract is
 * omitted for harnesses with native structured output.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sections {
  readonly worktreeIsolationNotice: string
  readonly registryToolDisclosure: string
  readonly outputRowJsonContract: string
  readonly schemaCorrectionPrompt: string
  readonly resumeWarning: string
}

/**
 * One assembled system channel and its stable step-key digest.
 *
 * @category models
 * @since 0.1.0
 */
export interface Assembled {
  readonly system: string
  readonly digest: string
}

const section = (title: string, content: string): string => `## ${title}\n\n${content.trim()}`

/**
 * Assembles exactly one deterministic system-channel string.
 *
 * @category constructors
 * @since 0.1.0
 */
export const assemble = (
  capabilities: HarnessCapabilities,
  sections: Sections,
  outputContract?: StructuredOutput.Contract
): Assembled => {
  const outputRowContract = outputContract === undefined
    ? sections.outputRowJsonContract
    : [
      sections.outputRowJsonContract.trim(),
      `Schema digest: ${outputContract.schemaDigest}`,
      "Exact JSON Schema:",
      renderSchema(outputContract)
    ].join("\n\n")
  const ordered = [
    section("Worktree isolation", sections.worktreeIsolationNotice),
    section("Registry and tools", sections.registryToolDisclosure),
    ...(capabilities.nativeStructuredOutput
      ? []
      : [
        section("Output row contract", outputRowContract),
        section(
          "Schema correction",
          `${sections.schemaCorrectionPrompt.trim()}\n\nIf the corrected row is still invalid, stop and report a typed schema failure. Do not attempt a second correction.`
        )
      ]),
    section("Resume safety", sections.resumeWarning)
  ]
  const system = ordered.join("\n\n")
  return {
    system,
    digest: digest(system)
  }
}
