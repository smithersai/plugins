/**
 * The published `@vercel/sandbox` still satisfies this host's structural slice.
 *
 * The slice exists so the package builds without the vendor installed, which
 * is only safe while the slice and the vendor agree. This file is where they
 * are made to agree: the type assertion below is a `check`-gate error the day
 * the vendor changes a signature, and the runtime assertions catch a shape
 * change that types alone would miss because the entry point is a class.
 */
import { describe, expect, it } from "vitest"
import type * as Sdk from "../src/Sdk.ts"
import * as VercelSandbox from "../src/VercelSandbox.ts"

/** Fails to compile when the vendor module stops implementing the slice. */
type Conforms<T extends Sdk.Sdk> = T

/**
 * @internal the assertion is the compile, not the value. Both halves of the
 * declared peer range are compiled: `@vercel/sandbox` is the 2.x devDependency
 * the runtime cases below drive, and `@vercel/sandbox-3` is an install alias
 * for the 3.x major, so neither half of `^2.0.0 || ^3.0.0` is a promise nobody
 * checks.
 */
export type Vendor2Conforms = Conforms<typeof import("@vercel/sandbox")>

/** @internal see above */
export type Vendor3Conforms = Conforms<typeof import("@vercel/sandbox-3")>

describe("@vercel/sandbox conformance", () => {
  it("exposes the entry point the host calls", async () => {
    const vendor = await import("@vercel/sandbox")

    expect(typeof vendor.Sandbox.create).toBe("function")
  })

  it("declares readFile as a stream read, which is why the host decodes", async () => {
    const vendor = await import("@vercel/sandbox")

    expect(typeof vendor.Sandbox.prototype.readFile).toBe("function")
    expect(typeof vendor.Sandbox.prototype.readFileToBuffer).toBe("function")
  })

  it("decodes a vendor stream, a byte array, and a missing file", async () => {
    const { Readable } = await import("node:stream")

    expect(await VercelSandbox.decodeFile(Readable.from(["a", "b"]))).toBe("ab")
    expect(await VercelSandbox.decodeFile(Readable.from([new TextEncoder().encode("bytes")]))).toBe(
      "bytes"
    )
    expect(await VercelSandbox.decodeFile(null)).toBe("")
  })
})
