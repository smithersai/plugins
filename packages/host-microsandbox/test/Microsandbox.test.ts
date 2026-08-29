/**
 * The Microsandbox host against a scripted SDK.
 *
 * The mock stands in for the vendor SDK the way this package's structural
 * declaration allows: it is a real implementation of the same interface, so
 * what is under test is the mapping — naming, persistence, egress delivery,
 * teardown — rather than a stub's return value.
 */
import { Effect, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Microsandbox from "../src/Microsandbox.ts"
import type * as Sdk from "../src/Sdk.ts"

interface Recorded {
  readonly names: Array<string>
  readonly ephemeral: Array<boolean>
  readonly execs: Array<{ shell: string; args: ReadonlyArray<string>; cwd: string; env: Record<string, string> }>
  readonly stops: Array<string>
  readonly writes: Array<[string, string]>
}

const mockSdk = (): { readonly sdk: Sdk.Sdk; readonly recorded: Recorded } => {
  const recorded: Recorded = { names: [], ephemeral: [], execs: [], stops: [], writes: [] }
  const sdk: Sdk.Sdk = {
    Sandbox: {
      builder: (name) => {
        recorded.names.push(name)
        let ephemeral = true
        const builder: Sdk.SandboxBuilder = {
          image: () => builder,
          ephemeral: (value) => {
            ephemeral = value
            return builder
          },
          create: () => {
            recorded.ephemeral.push(ephemeral)
            const files = new Map<string, string>([["/etc/hostname", name]])
            const sandbox: Sdk.Sandbox = {
              fs: () => ({
                write: (path, content) => {
                  recorded.writes.push([path, content])
                  files.set(path, content)
                  return Promise.resolve()
                },
                readToString: (path) =>
                  files.has(path)
                    ? Promise.resolve(files.get(path) as string)
                    : Promise.reject(new Error(`no such file ${path}`)),
                mkdir: () => Promise.resolve()
              }),
              execStreamWith: (shell, configure) => {
                let args: ReadonlyArray<string> = []
                let cwd = ""
                let env: Record<string, string> = {}
                const execBuilder: Sdk.ExecBuilder = {
                  args: (value) => {
                    args = value
                    return execBuilder
                  },
                  cwd: (value) => {
                    cwd = value
                    return execBuilder
                  },
                  envs: (value) => {
                    env = { ...value }
                    return execBuilder
                  }
                }
                configure(execBuilder)
                recorded.execs.push({ shell, args, cwd, env })
                return Promise.resolve({
                  output: () => Promise.resolve("out"),
                  error: () => Promise.resolve(""),
                  exitCode: () => Promise.resolve(0)
                })
              },
              stop: () => {
                recorded.stops.push(name)
                return Promise.resolve()
              }
            }
            return Promise.resolve(sandbox)
          }
        }
        return builder
      }
    }
  }
  return { sdk, recorded }
}

const decode = (bytes: ReadonlyArray<Uint8Array>) =>
  new TextDecoder().decode(bytes[0] ?? new Uint8Array())

describe("Microsandbox.sandboxName", () => {
  it("derives a stable name from the session key", () => {
    expect(Microsandbox.sandboxName("run-1")).toBe("smithers-run-1")
    expect(Microsandbox.sandboxName("run/1")).toBe("smithers-run-1")
  })

  it("hashes a key too long to name, so two sessions cannot collide", () => {
    const long = "x".repeat(400)
    const other = `${long}y`

    expect(Microsandbox.sandboxName(long)).not.toBe(Microsandbox.sandboxName(other))
    expect(Microsandbox.sandboxName(long).length).toBeLessThanOrEqual(128)
  })
})

describe("Microsandbox provider", () => {
  it("runs a command through the shell with the workdir and egress environment", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      Microsandbox.make({ sdk, session: "run-1", egress: { httpsProxy: "http://proxy:8080" } })
    )

    const output = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      const started = yield* provider.spawn("bun run build", {})
      const chunks = yield* Stream.runCollect(started.stdout)
      const exitCode = yield* started.exitCode
      return { text: decode(chunks), exitCode }
    })))

    expect(output).toEqual({ text: "out", exitCode: 0 })
    expect(recorded.execs[0]).toMatchObject({
      shell: "/bin/sh",
      args: ["-lc", "bun run build"],
      cwd: "/workspace"
    })
    expect(recorded.execs[0]?.env["HTTPS_PROXY"]).toBe("http://proxy:8080")
  })

  it("creates an ephemeral microVM and stops it when the scope closes", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(Microsandbox.make({ sdk, session: "run-1" }))

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.ephemeral).toEqual([true])
    expect(recorded.stops).toEqual(["smithers-run-1"])
  })

  it("keeps a sticky microVM alive, because the next session reopens it", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      Microsandbox.make({ sdk, session: "run-1", persistence: "sticky" })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.ephemeral).toEqual([false])
    expect(recorded.stops).toEqual([])
  })

  it("answers a liveness probe from the guest", async () => {
    const { sdk } = mockSdk()
    const provider = Result.getOrThrow(Microsandbox.make({ sdk, session: "run-1" }))

    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      return yield* Effect.result(provider.ping ?? Effect.void)
    })))

    expect(outcome._tag).toBe("Success")
  })

  it("refuses to spawn before the session is open", async () => {
    const { sdk } = mockSdk()
    const provider = Result.getOrThrow(Microsandbox.make({ sdk, session: "run-1" }))

    const outcome = await Effect.runPromise(Effect.scoped(Effect.result(provider.spawn("true", {}))))

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("not open")
  })

  it("surfaces a creation failure as a typed provider error", async () => {
    const failing: Sdk.Sdk = {
      Sandbox: {
        builder: () => {
          const builder: Sdk.SandboxBuilder = {
            image: () => builder,
            ephemeral: () => builder,
            create: () => Promise.reject(new Error("no hypervisor"))
          }
          return builder
        }
      }
    }
    const provider = Result.getOrThrow(Microsandbox.make({ sdk: failing, session: "run-1" }))

    const outcome = await Effect.runPromise(Effect.scoped(Effect.result(provider.open("run-1"))))

    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("no hypervisor")
  })
})
