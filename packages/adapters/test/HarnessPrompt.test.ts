import { describe, expect, it } from "vitest"
import * as HarnessCapabilities from "../src/HarnessCapabilities.ts"
import * as HarnessPrompt from "../src/HarnessPrompt.ts"

const capabilities = (
  nativeStructuredOutput: boolean
): HarnessCapabilities.HarnessCapabilities =>
  new HarnessCapabilities.HarnessCapabilities({
    name: "test-cli",
    version: "1.0.0",
    resume: "flag",
    mcpBootstrap: "none",
    skillsInstall: "none",
    configDirIsolation: true,
    nativeStructuredOutput,
    steer: false,
    images: false,
    usage: false
  })

const sections: HarnessPrompt.Sections = {
  worktreeIsolationNotice: "Stay inside the assigned worktree.",
  registryToolDisclosure: "Only the disclosed registry tools are available.",
  outputRowJsonContract: "Return one JSON object matching the output-row schema.",
  schemaCorrectionPrompt: "On an invalid row, emit one explicit corrected row.",
  resumeWarning: "Resume only the session supplied by the owning engine."
}

describe("HarnessPrompt", () => {
  it("assembles deterministic system text and digest", () => {
    const first = HarnessPrompt.assemble(capabilities(false), sections)
    const second = HarnessPrompt.assemble(capabilities(false), { ...sections })

    expect(first).toEqual(second)
    expect(first.digest).toHaveLength(64)
    expect(first.system.indexOf("Worktree isolation")).toBeLessThan(
      first.system.indexOf("Registry and tools")
    )
    expect(first.system.indexOf("Registry and tools")).toBeLessThan(
      first.system.indexOf("Output row contract")
    )
    expect(first.system.indexOf("Output row contract")).toBeLessThan(
      first.system.indexOf("Schema correction")
    )
    expect(first.system.indexOf("Schema correction")).toBeLessThan(
      first.system.indexOf("Resume safety")
    )
  })

  it("includes the output-row contract only without native structured output", () => {
    expect(HarnessPrompt.assemble(capabilities(false), sections).system).toContain(
      "Output row contract"
    )
    expect(HarnessPrompt.assemble(capabilities(true), sections).system).not.toContain(
      "Output row contract"
    )
    expect(HarnessPrompt.assemble(capabilities(true), sections).system).not.toContain(
      "Schema correction"
    )
  })

  it("declares exactly one correction before typed failure", () => {
    const assembled = HarnessPrompt.assemble(capabilities(false), sections)

    expect(assembled.system).toContain("one explicit corrected row")
    expect(assembled.system).toContain("Do not attempt a second correction")
  })
})
