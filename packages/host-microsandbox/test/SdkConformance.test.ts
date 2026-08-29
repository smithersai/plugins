/**
 * The published `microsandbox` still satisfies this host's structural slice.
 *
 * This is the suite the 0.x package called `sdkCompatibility`: it proves the
 * vendor's builder and exec surface without booting a microVM, so it runs on a
 * machine with no hypervisor. The type assertion is the `check`-gate half; the
 * runtime assertions catch a shape change that types alone would miss because
 * the entry point is a class.
 */
import { describe, expect, it } from "vitest"
import type * as Sdk from "../src/Sdk.ts"

/** Fails to compile when the vendor module stops implementing the slice. */
type Conforms<T extends Sdk.Sdk> = T

/** @internal the assertion is the compile, not the value */
export type VendorConforms = Conforms<typeof import("microsandbox")>

describe("microsandbox conformance", () => {
  it("exposes every builder setter this host calls", async () => {
    const { Sandbox } = await import("microsandbox")
    const builder = Sandbox.builder("smithers-sdk-conformance")

    for (
      const setter of [
        "image",
        "fromSnapshot",
        "cpus",
        "maxCpus",
        "memory",
        "maxMemory",
        "shell",
        "security",
        "pullPolicy",
        "labels",
        "scripts",
        "maxDuration",
        "idleTimeout",
        "ephemeral",
        "detached",
        "disableNetwork",
        "create"
      ] as const
    ) {
      expect(typeof builder[setter], setter).toBe("function")
    }
  })

  it("still answers a command through collect, not through per-stream readers", async () => {
    const vendor = await import("microsandbox")

    // The 1.0.0-rc.0 port originally declared `output()`, `error()` and
    // `exitCode()` on the handle. None of the three exists; every command
    // would have failed at the first call.
    expect(typeof vendor.ExecHandle.prototype.collect).toBe("function")
    expect(typeof vendor.ExecOutput.prototype.stdout).toBe("function")
    expect(typeof vendor.ExecOutput.prototype.stderr).toBe("function")
    expect("output" in vendor.ExecHandle.prototype).toBe(false)
  })

  it("still reads and writes the guest through fs()", async () => {
    const vendor = await import("microsandbox")

    expect(typeof vendor.SandboxFsOps.prototype.write).toBe("function")
    expect(typeof vendor.SandboxFsOps.prototype.readToString).toBe("function")
    expect(typeof vendor.SandboxFsOps.prototype.mkdir).toBe("function")
  })
})
