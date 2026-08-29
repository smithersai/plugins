/**
 * The Microsandbox host against a scripted SDK.
 *
 * The double stands in for the vendor SDK the way this package's structural
 * declaration allows: it is a real implementation of the same interface, so
 * what is under test is the mapping — naming, resources, persistence, egress
 * delivery, teardown — rather than a stub's return value.
 */
import { Conformance } from "@smthrs-plugins/provider-kit"
import { ProviderConformance } from "@smthrs/sandbox"
import { Effect, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Microsandbox from "../src/Microsandbox.ts"
import type * as Sdk from "../src/Sdk.ts"

interface Recorded {
  readonly names: Array<string>
  readonly ephemeral: Array<boolean>
  readonly settings: Array<Record<string, unknown>>
  readonly execs: Array<{ shell: string; args: ReadonlyArray<string>; cwd: string; env: Record<string, string> }>
  readonly stops: Array<string>
  readonly writes: Array<[string, string]>
}

/**
 * What the guest "runs".
 *
 * Single tokens on purpose. `ProviderConformance` renders its fixture through
 * `CommandLine.render`, which quotes anything with a space, so a multi-word
 * fixture would reach the guest as one quoted word and be reported as a
 * violation of the suite rather than of the host.
 */
const scripts: Record<string, { readonly stdout?: string; readonly stderr?: string; readonly code?: number }> = {
  greet: { stdout: "hello" },
  complain: { stderr: "oops" },
  boom: { code: 3 },
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

const mockSdk = (): { readonly sdk: Sdk.Sdk; readonly recorded: Recorded } => {
  const recorded: Recorded = { names: [], ephemeral: [], settings: [], execs: [], stops: [], writes: [] }
  const sdk: Sdk.Sdk = {
    Sandbox: {
      builder: (name) => {
        recorded.names.push(name)
        const settings: Record<string, unknown> = {}
        const set = (key: string, value: unknown): Sdk.SandboxBuilder => {
          settings[key] = value
          return builder
        }
        const builder: Sdk.SandboxBuilder = {
          image: (value) => set("image", value),
          fromSnapshot: (value) => set("snapshot", value),
          cpus: (value) => set("cpus", value),
          maxCpus: (value) => set("maxCpus", value),
          memory: (value) => set("memory", value),
          maxMemory: (value) => set("maxMemory", value),
          shell: (value) => set("shell", value),
          security: (value) => set("security", value),
          pullPolicy: (value) => set("pullPolicy", value),
          labels: (value) => set("labels", value),
          scripts: (value) => set("scripts", value),
          maxDuration: (value) => set("maxDuration", value),
          idleTimeout: (value) => set("idleTimeout", value),
          detached: (value) => set("detached", value),
          disableNetwork: () => set("disableNetwork", true),
          ephemeral: (value) => set("ephemeral", value),
          create: () => {
            recorded.ephemeral.push(settings["ephemeral"] === true)
            recorded.settings.push({ ...settings })
            const files = new Map<string, string>([["/etc/hostname", name]])
            const sandbox: Sdk.Sandbox = {
              name,
              fs: () => ({
                write: (path, content) => {
                  const text = typeof content === "string" ? content : new TextDecoder().decode(content)
                  recorded.writes.push([path, text])
                  files.set(path, text)
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
                const script = scripts[args[1] ?? ""] ?? { stdout: "out" }
                return Promise.resolve({
                  collect: () =>
                    Promise.resolve({
                      code: script.code ?? 0,
                      stdout: () => script.stdout ?? "",
                      stderr: () => script.stderr ?? ""
                    })
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

  it("carries every declared resource and lifetime option onto the builder", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(Microsandbox.make({
      sdk,
      session: "run-1",
      image: "oven/bun:1",
      cpus: 2,
      maxCpus: 4,
      memoryMib: 1024,
      maxMemoryMib: 2048,
      security: "restricted",
      pullPolicy: "if-missing",
      labels: { owner: "smithers" },
      scripts: { prepare: "#!/bin/sh\necho ready" },
      maxDurationSecs: 900,
      idleTimeoutSecs: 120,
      disableNetwork: true
    }))

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.settings[0]).toMatchObject({
      image: "oven/bun:1",
      cpus: 2,
      maxCpus: 4,
      memory: 1024,
      maxMemory: 2048,
      security: "restricted",
      pullPolicy: "if-missing",
      labels: { owner: "smithers" },
      scripts: { prepare: "#!/bin/sh\necho ready" },
      maxDuration: 900,
      idleTimeout: 120,
      disableNetwork: true
    })
  })

  it("boots from a snapshot instead of an image when one is named", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      Microsandbox.make({ sdk, session: "run-1", snapshot: "snap-7" })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.settings[0]).toMatchObject({ snapshot: "snap-7" })
    expect(recorded.settings[0]?.["image"]).toBeUndefined()
  })

  it("refuses an image and a snapshot together", async () => {
    const { sdk } = mockSdk()
    const provider = Result.getOrThrow(
      Microsandbox.make({ sdk, session: "run-1", image: "oven/bun:1", snapshot: "snap-7" })
    )

    const outcome = await Effect.runPromise(Effect.scoped(Effect.result(provider.open("run-1"))))

    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("exclusive")
  })

  it("detaches a sticky microVM so it outlives this process", async () => {
    const { recorded, sdk } = mockSdk()
    const provider = Result.getOrThrow(
      Microsandbox.make({ sdk, session: "run-1", persistence: "sticky" })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.settings[0]).toMatchObject({ ephemeral: false, detached: true })
  })

  it("passes the shared session conformance suite", async () => {
    const { sdk } = mockSdk()

    const violations = await Effect.runPromise(Conformance.check({
      open: Microsandbox.session({ sdk, session: "run-1" }),
      probePath: "/workspace/.smithers/probe.txt",
      ...commands
    }))

    expect(Conformance.format(violations)).toBe("session conforms")
  })

  it("passes the sandbox provider conformance suite", async () => {
    const { sdk } = mockSdk()
    const provider = Result.getOrThrow(Microsandbox.make({ sdk, session: "run-1" }))

    const violations = await Effect.runPromise(ProviderConformance.check(provider, {
      writes: commands.writes,
      output: commands.output,
      fails: commands.fails,
      failureCode: commands.failureCode,
      runs: "serve"
    }))

    expect(ProviderConformance.format(violations)).toBe("provider conforms")
  })

  it("surfaces a creation failure as a typed provider error", async () => {
    const failing: Sdk.Sdk = {
      Sandbox: {
        builder: () => {
          const builder: Sdk.SandboxBuilder = {
            image: () => builder,
            fromSnapshot: () => builder,
            cpus: () => builder,
            maxCpus: () => builder,
            memory: () => builder,
            maxMemory: () => builder,
            shell: () => builder,
            security: () => builder,
            pullPolicy: () => builder,
            labels: () => builder,
            scripts: () => builder,
            maxDuration: () => builder,
            idleTimeout: () => builder,
            detached: () => builder,
            disableNetwork: () => builder,
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
