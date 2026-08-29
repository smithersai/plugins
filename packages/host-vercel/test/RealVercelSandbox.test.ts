/**
 * The host against a real Vercel Sandbox.
 *
 * Credential-gated, never mocked, and never a fabricated pass: without the
 * three environment variables the case is a named skip naming the ones that
 * are missing. It spends real sandbox minutes, so it opens one sandbox, plants
 * three fixture scripts in it, and runs both shared conformance suites.
 *
 * The fixtures are absolute paths because `ProviderConformance` renders its
 * command through `CommandLine.render`, which quotes anything with a space. A
 * path is one unquoted token; `printf hi` would reach the guest as one quoted
 * word.
 */
import { Conformance } from "@smthrs-plugins/provider-kit"
import { ProviderConformance } from "@smthrs/sandbox"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as VercelSandbox from "../src/VercelSandbox.ts"

const required = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const

const missing = required.filter((name) => (process.env[name] ?? "") === "")

const dir = "/vercel/sandbox/.smithers-conformance"

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

describe("Vercel Sandbox, real backend", () => {
  it("passes both conformance suites inside a real sandbox", async (ctx) => {
    if (missing.length > 0) {
      ctx.skip(`no Vercel credential in the environment: ${missing.join(", ")} unset`)
      return
    }

    const vendor = await import("@vercel/sandbox")
    const options = {
      sdk: vendor,
      session: `smithers-host-vercel-${Date.now()}`,
      env: process.env,
      timeoutMs: 5 * 60_000
    }
    const open = VercelSandbox.session(options)

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

    const provider = Result.getOrThrow(VercelSandbox.make(options))
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
  }, 600_000)
})
