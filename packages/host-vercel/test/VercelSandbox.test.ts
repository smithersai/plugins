/**
 * Credential precedence and the extend-timeout loop.
 *
 * The SDK stand-in is a real implementation of this package's structural
 * declaration, so what is asserted is the mapping: which credential goes on
 * the wire, and how a lifetime longer than one create allows is reached.
 */
import { Conformance } from "@smthrs-plugins/provider-kit"
import { ProviderConformance } from "@smthrs/sandbox"
import { Effect, Result, Stream } from "effect"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Credentials from "../src/Credentials.ts"
import type * as Sdk from "../src/Sdk.ts"
import * as VercelSandbox from "../src/VercelSandbox.ts"

interface Recorded {
  readonly created: Array<Parameters<Sdk.Sdk["Sandbox"]["create"]>[0]>
  readonly extended: Array<number>
  readonly commands: Array<Parameters<Sdk.Sandbox["runCommand"]>[0]>
  readonly stopped: Array<true>
}

/**
 * A guest with a real file system and three interpretable commands.
 *
 * The vendor answers a file as a readable stream, never as text, so the double
 * answers one too. A double that answered a string would agree with the host's
 * old bug instead of catching it.
 */
const mockSdk = (): { readonly sdk: Sdk.Sdk; readonly recorded: Recorded } => {
  const recorded: Recorded = { created: [], extended: [], commands: [], stopped: [] }
  const files = new Map<string, string>()
  const sdk: Sdk.Sdk = {
    Sandbox: {
      create: (input) => {
        recorded.created.push(input)
        const sandbox: Sdk.Sandbox = {
          name: "sbx_1",
          writeFiles: (written) => {
            for (const file of written) {
              files.set(
                file.path,
                typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content)
              )
            }
            return Promise.resolve()
          },
          readFile: (file) => {
            const content = files.get(file.path)
            return Promise.resolve(content === undefined ? null : Readable.from([content]))
          },
          runCommand: (command) => {
            recorded.commands.push(command)
            const line = command.args?.[1] ?? ""
            const script = scripts[line]
            return Promise.resolve({
              exitCode: script?.exitCode ?? 0,
              stdout: () => Promise.resolve(script === undefined ? "done" : script.stdout ?? ""),
              stderr: () => Promise.resolve(script?.stderr ?? "")
            })
          },
          extendTimeout: (millis) => {
            recorded.extended.push(millis)
            return Promise.resolve()
          },
          stop: () => {
            recorded.stopped.push(true)
            return Promise.resolve()
          }
        }
        return Promise.resolve(sandbox)
      }
    }
  }
  return { sdk, recorded }
}

/**
 * What the guest "runs".
 *
 * Single tokens on purpose. `ProviderConformance` renders its fixture through
 * `CommandLine.render`, which quotes anything with a space, so a multi-word
 * fixture would reach the guest as one quoted word and be reported as a
 * conformance violation of the suite rather than of the host.
 */
const scripts: Record<string, { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }> = {
  greet: { stdout: "hello" },
  complain: { stderr: "oops" },
  boom: { exitCode: 3 },
  serve: {}
}

const commands = {
  writes: "greet",
  output: "hello",
  writesToStderr: "complain",
  errorOutput: "oops",
  fails: "boom",
  failureCode: 3
}

describe("Credentials.resolve", () => {
  it("prefers an explicitly configured OIDC token", () => {
    const resolved = Credentials.resolve(
      { oidcToken: "oidc", token: "pat", teamId: "t", projectId: "p" },
      { VERCEL_OIDC_TOKEN: "ambient" }
    )

    expect(resolved).toEqual({ token: "oidc" })
  })

  it("takes the ambient OIDC token over a personal access token", () => {
    const resolved = Credentials.resolve(
      { token: "pat", teamId: "t", projectId: "p" },
      { VERCEL_OIDC_TOKEN: "ambient" }
    )

    expect(resolved).toEqual({ token: "ambient" })
  })

  it("uses an access token only with the team and project it identifies", () => {
    expect(Credentials.resolve({ token: "pat", teamId: "t", projectId: "p" })).toEqual({
      token: "pat",
      teamId: "t",
      projectId: "p"
    })
    expect(Credentials.resolve({ token: "pat", teamId: "t" })).toEqual({})
  })

  it("answers nothing rather than failing, so the SDK can discover its own", () => {
    expect(Credentials.resolve()).toEqual({})
  })

  it("reads the environment it was handed, never process.env", () => {
    expect(Credentials.resolve({}, { VERCEL_TOKEN: "e", VERCEL_TEAM_ID: "t", VERCEL_PROJECT_ID: "p" })).toEqual({
      token: "e",
      teamId: "t",
      projectId: "p"
    })
  })
})

describe("VercelSandbox", () => {
  it("creates at the ceiling and extends by the remainder, not the target", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      VercelSandbox.make({ sdk, session: "run-1", timeoutMs: 15 * 60_000 })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.created[0]?.timeout).toBe(VercelSandbox.createCeilingMillis)
    expect(recorded.extended).toEqual([15 * 60_000 - VercelSandbox.createCeilingMillis])
  })

  it("does not extend a lifetime one create already covers", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(VercelSandbox.make({ sdk, session: "run-1", timeoutMs: 60_000 }))

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.created[0]?.timeout).toBe(60_000)
    expect(recorded.extended).toEqual([])
  })

  it("refuses a lifetime past the plan cap before it reaches the wire", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      VercelSandbox.make({ sdk, session: "run-1", timeoutMs: 60_000, maxDurationMs: 30_000 })
    )

    const outcome = await Effect.runPromise(Effect.scoped(Effect.result(provider.open("run-1"))))

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("plan cap")
    expect(recorded.created).toEqual([])
  })

  it("runs a command through the shell with the egress environment", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      VercelSandbox.make({ sdk, session: "run-1", egress: { httpProxy: "http://proxy:1" } })
    )

    const text = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      const started = yield* provider.spawn("pnpm test", {})
      const chunks = yield* Stream.runCollect(started.stdout)
      return new TextDecoder().decode(chunks[0] ?? new Uint8Array())
    })))

    expect(text).toBe("done")
    expect(recorded.commands[0]).toMatchObject({ cmd: "sh", args: ["-lc", "pnpm test"] })
    expect(recorded.commands[0]?.env?.["HTTP_PROXY"]).toBe("http://proxy:1")
  })

  it("passes the shared session conformance suite", async () => {
    const { sdk } = mockSdk()
    const violations = await Effect.runPromise(Conformance.check({
      open: VercelSandbox.session({ sdk, session: "run-1" }),
      probePath: "/vercel/sandbox/.smithers/probe.txt",
      ...commands
    }))

    expect(Conformance.format(violations)).toBe("session conforms")
  })

  it("passes the sandbox provider conformance suite", async () => {
    const { sdk } = mockSdk()
    const provider = Result.getOrThrow(VercelSandbox.make({ sdk, session: "run-1" }))

    const violations = await Effect.runPromise(ProviderConformance.check(provider, {
      writes: commands.writes,
      output: commands.output,
      fails: commands.fails,
      failureCode: commands.failureCode,
      runs: "serve"
    }))

    expect(ProviderConformance.format(violations)).toBe("provider conforms")
  })

  it("reads a file the vendor does not have as empty text", async () => {
    const { sdk } = mockSdk()

    const text = await Effect.runPromise(Effect.scoped(Effect.flatMap(
      VercelSandbox.session({ sdk, session: "run-1" })("run-1"),
      (session) => session.readFile("/vercel/sandbox/missing")
    )))

    expect(text).toBe("")
  })

  it("reports the vendor's own sandbox name as the remote id", async () => {
    const { sdk } = mockSdk()

    const remoteId = await Effect.runPromise(Effect.scoped(Effect.map(
      VercelSandbox.session({ sdk, session: "run-1" })("run-1"),
      (session) => session.remoteId
    )))

    expect(remoteId).toBe("sbx_1")
  })

  it("stops the sandbox when the scope closes", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(VercelSandbox.make({ sdk, session: "run-1" }))

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.stopped).toEqual([true])
  })
})
