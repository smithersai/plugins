import * as EngineLike from "@smithers/harness/EngineLike"
import { Effect, HashMap } from "effect"
import { describe, expect, it } from "vitest"
import * as AdapterRuntime from "../src/AdapterRuntime.ts"
import * as HarnessCapabilities from "../src/HarnessCapabilities.ts"

describe("AdapterRuntime", () => {
  it("resolves built-ins with plan-card material and constructs their harnesses", () => {
    const runtime = AdapterRuntime.make()
    const resolved = Effect.runSync(runtime.resolve("codex", { multiSeat: true }))
    expect(resolved.planCard).toMatchObject({
      harness: "codex",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      configDirIsolation: true
    })
    const harness = Effect.runSync(
      runtime.harness("codex").pipe(
        Effect.provideService(EngineLike.EngineLike, EngineLike.makeNoop())
      )
    )
    expect(harness.run).toBeTypeOf("function")
  })

  it("excludes a non-isolated harness from the constructed multi-seat registry", () => {
    const spec = Effect.runSync(AdapterRuntime.make().resolve("codex")).spec
    const unsafe = new HarnessCapabilities.HarnessCapabilities({
      ...spec.capabilities,
      name: "unsafe",
      configDirIsolation: false
    })
    const runtime = AdapterRuntime.make(
      HashMap.make(["unsafe", { ...spec, capabilities: unsafe }]),
      HarnessCapabilities.makeRegistry([unsafe])
    )
    expect(Effect.runSyncExit(runtime.resolve("unsafe", { multiSeat: true }))._tag).toBe("Failure")
  })
})
