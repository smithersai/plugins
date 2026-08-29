import { HashMap, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as HarnessCapabilities from "../src/HarnessCapabilities.ts"
import * as AdapterRuntime from "../src/AdapterRuntime.ts"

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

  it("registers every shipped adapter under the same name", () => {
    for (const name of ["claude-code", "codex", "kimi", "antigravity"]) {
      expect(Option.getOrUndefined(HarnessCapabilities.lookup(AdapterRuntime.capabilities, name))?.name).toBe(name)
      expect(Option.getOrUndefined(HashMap.get(AdapterRuntime.byName, name))?.capabilities.name).toBe(name)
    }
  })

  it("ships no adapter the migration ledger deleted", () => {
    for (const name of ["hermes", "openclaw", "herdr", "aws", "gcp", "daytona", "opencode"]) {
      expect(Option.isNone(HarnessCapabilities.lookup(AdapterRuntime.capabilities, name))).toBe(true)
    }
  })

  it("evicts a harness from the multi-seat pool when re-registered without isolation", () => {
    const isolated = HarnessCapabilities.register(HarnessCapabilities.makeRegistry(), capabilities())
    expect(HashMap.has(isolated.multiSeatRecords, "test-cli")).toBe(true)

    // Re-registering the same name without config-dir isolation must remove the
    // stale multi-seat entry, not merely skip adding a new one.
    const downgraded = HarnessCapabilities.register(isolated, capabilities({ configDirIsolation: false }))
    expect(HashMap.has(downgraded.records, "test-cli")).toBe(true)
    expect(HashMap.has(downgraded.multiSeatRecords, "test-cli")).toBe(false)
    // The earlier registry is untouched.
    expect(HashMap.has(isolated.multiSeatRecords, "test-cli")).toBe(true)
  })

  it("reports a lookup miss as None", () => {
    expect(Option.isNone(HarnessCapabilities.lookup(HarnessCapabilities.makeRegistry(), "absent"))).toBe(true)
  })
})
