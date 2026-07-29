import { HashMap, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as HarnessCapabilities from "../src/HarnessCapabilities.ts"
import { builtInCapabilities, builtInSpecs } from "../src/index.ts"

const capabilities = (
  overrides: Partial<HarnessCapabilities.HarnessCapabilities> = {}
): HarnessCapabilities.HarnessCapabilities =>
  new HarnessCapabilities.HarnessCapabilities({
    name: "test-cli",
    version: "1.2.3",
    resume: "flag",
    mcpBootstrap: "inline-config",
    skillsInstall: "plugin-dir",
    configDirIsolation: true,
    nativeStructuredOutput: false,
    steer: false,
    images: true,
    usage: true,
    ...overrides
  })

describe("HarnessCapabilities", () => {
  it("fingerprints equal records independently of object construction order", () => {
    const first = capabilities()
    const second = new HarnessCapabilities.HarnessCapabilities({
      usage: true,
      images: true,
      steer: false,
      nativeStructuredOutput: false,
      configDirIsolation: true,
      skillsInstall: "plugin-dir",
      mcpBootstrap: "inline-config",
      resume: "flag",
      version: "1.2.3",
      name: "test-cli"
    })

    expect(HarnessCapabilities.fingerprint(first)).toBe(
      HarnessCapabilities.fingerprint(second)
    )
    expect(HarnessCapabilities.fingerprint(first)).toHaveLength(64)
  })

  it("excludes harnesses without isolated config directories from multi-seat pools", () => {
    expect(HarnessCapabilities.eligibleForMultiSeatPool(capabilities())).toBe(true)
    expect(
      HarnessCapabilities.eligibleForMultiSeatPool(
        capabilities({ configDirIsolation: false })
      )
    ).toBe(false)
  })

  it("registers records without mutating the previous registry", () => {
    const empty = HarnessCapabilities.makeRegistry()
    const registered = HarnessCapabilities.register(empty, capabilities())

    expect(Option.isNone(HarnessCapabilities.lookup(empty, "test-cli"))).toBe(true)
    expect(
      Option.getOrUndefined(HarnessCapabilities.lookup(registered, "test-cli"))?.version
    ).toBe("1.2.3")
  })

  it("registers every built-in spec and capability under the same name", () => {
    for (const name of ["claude-code", "codex"]) {
      expect(Option.getOrUndefined(HarnessCapabilities.lookup(builtInCapabilities, name))?.name).toBe(name)
      expect(Option.getOrUndefined(HashMap.get(builtInSpecs, name))?.capabilities.name).toBe(name)
    }
  })
})
