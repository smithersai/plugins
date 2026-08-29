/**
 * The host against a real Microsandbox server.
 *
 * The 0.x package shipped the only real-backend provider test in the tree and
 * it is restored here, credential-gated. Without a reachable server the case is
 * a named skip; it is never a fabricated pass. Plue workspaces are Microsandbox
 * microVMs, so this is the host whose drift costs the most.
 */
import { Conformance } from "@smthrs-plugins/provider-kit"
import { ProviderConformance } from "@smthrs/sandbox"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Microsandbox from "../src/Microsandbox.ts"

const serverUrl = process.env["MSB_SERVER_URL"] ?? ""
const apiKey = process.env["MSB_API_KEY"] ?? ""

const dir = "/workspace/.smithers-conformance"

const plant = [
  `mkdir -p ${dir}`,
  `printf '#!/bin/sh\\nprintf hello\\n' > ${dir}/greet`,
  `printf '#!/bin/sh\\nprintf oops 1>&2\\n' > ${dir}/complain`,
  `printf '#!/bin/sh\\nexit 3\\n' > ${dir}/boom`,
  `printf '#!/bin/sh\\nsleep 120\\n' > ${dir}/serve`,
  `chmod +x ${dir}/greet ${dir}/complain ${dir}/boom ${dir}/serve`
].join(" && ")

const commands = {
  writes: `${dir}/greet`,
  output: "hello",
  writesToStderr: `${dir}/complain`,
  errorOutput: "oops",
  fails: `${dir}/boom`,
  failureCode: 3
}

describe("Microsandbox, real backend", () => {
  it("passes both conformance suites inside a real microVM", async (ctx) => {
    if (serverUrl === "" || apiKey === "") {
      const unset = [
        ...(serverUrl === "" ? ["MSB_SERVER_URL"] : []),
        ...(apiKey === "" ? ["MSB_API_KEY"] : [])
      ]
      ctx.skip(`no Microsandbox server in the environment: ${unset.join(", ")} unset`)
      return
    }

    const vendor = await import("microsandbox")
    const options = {
      sdk: vendor,
      session: `smithers-host-microsandbox-${Date.now()}`,
      workdir: "/workspace",
      maxDurationSecs: 900,
      idleTimeoutSecs: 120
    }
    const open = Microsandbox.session(options)

    const planted = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const session = yield* open("plant")
      const started = yield* session.exec(plant, {})
      return yield* started.exitCode
    })))
    expect(planted).toBe(0)

    const sessionViolations = await Effect.runPromise(
      Conformance.check({ open, probePath: `${dir}/probe.txt`, ...commands })
    )
    expect(Conformance.format(sessionViolations)).toBe("session conforms")

    const provider = Result.getOrThrow(Microsandbox.make(options))
    const providerViolations = await Effect.runPromise(
      ProviderConformance.check(provider, {
        writes: commands.writes,
        output: commands.output,
        fails: commands.fails,
        failureCode: commands.failureCode,
        runs: `${dir}/serve`
      })
    )
    expect(ProviderConformance.format(providerViolations)).toBe("provider conforms")
  }, 900_000)
})
