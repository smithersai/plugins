/**
 * The Cloudflare host: `sleepAfter` pass-through, both execution modes, and
 * the D1 transaction refusal.
 *
 * Process mode is the one worth the test. A detached start answers a handle,
 * and reporting that as a finished run is a silent success trap: the caller
 * gets nothing back and never learns what the command wrote or that it failed.
 * The case below pins process mode against exec mode on the same command.
 */
import { Conformance } from "@smthrs-plugins/provider-kit"
import { ProviderConformance } from "@smthrs/sandbox"
import { Effect, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as CloudflareSandbox from "../src/CloudflareSandbox.ts"
import * as D1 from "../src/D1.ts"
import type * as Sdk from "../src/Sdk.ts"

interface Recorded {
  readonly ids: Array<string>
  readonly options: Array<Parameters<Sdk.GetSandbox>[2]>
  readonly execs: Array<{ command: string; cwd?: string | undefined; env?: Readonly<Record<string, unknown>> }>
  readonly started: Array<string>
  readonly waited: Array<true>
}

/**
 * What the guest "runs".
 *
 * Single tokens on purpose. `ProviderConformance` renders its fixture through
 * `CommandLine.render`, which quotes anything with a space, so a multi-word
 * fixture would reach the guest as one quoted word and be reported as a
 * violation of the suite rather than of the host.
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

const outcomeOf = (command: string) => scripts[command] ?? { stdout: "exec-out" }

const mockSdk = (): { readonly getSandbox: Sdk.GetSandbox; readonly recorded: Recorded } => {
  const recorded: Recorded = { ids: [], options: [], execs: [], started: [], waited: [] }
  const getSandbox: Sdk.GetSandbox = (_binding, id, options) => {
    recorded.ids.push(id)
    recorded.options.push(options)
    const files = new Map<string, string>()
    const sandbox: Sdk.Sandbox = {
      mkdir: (path) => Promise.resolve({ path }),
      writeFile: (path, content) => {
        files.set(path, content)
        return Promise.resolve({ success: true })
      },
      readFile: (path) => Promise.resolve({ content: files.get(path) ?? "" }),
      exec: (command, execOptions) => {
        recorded.execs.push({ command, ...execOptions })
        const script = outcomeOf(command)
        return Promise.resolve({
          exitCode: script.exitCode ?? 0,
          stdout: script.stdout ?? "",
          stderr: script.stderr ?? ""
        })
      },
      startProcess: (command) => {
        recorded.started.push(command)
        const script = outcomeOf(command)
        return Promise.resolve({
          id: "proc-1",
          pid: 42,
          waitForExit: () => {
            recorded.waited.push(true)
            return Promise.resolve({ exitCode: script.exitCode ?? 0 })
          },
          // The vendor keeps a detached process's output off the handle; it is
          // fetched once the process has exited.
          getLogs: () => Promise.resolve({ stdout: script.stdout ?? "", stderr: script.stderr ?? "" }),
          kill: () => Promise.resolve()
        })
      }
    }
    return sandbox
  }
  return { getSandbox, recorded }
}

const ran = (mode: "exec" | "process", command: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const { getSandbox } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", execution: mode })
    )
    yield* provider.open("run-1")
    const started = yield* provider.spawn(command, {})
    const decoder = new TextDecoder()
    const stdout = (yield* Stream.runCollect(started.stdout)).map((c) => decoder.decode(c)).join("")
    const stderr = (yield* Stream.runCollect(started.stderr)).map((c) => decoder.decode(c)).join("")
    return { stdout, stderr, exitCode: yield* started.exitCode }
  })))

describe("CloudflareSandbox", () => {
  it("passes sleepAfter through, because it is the container cost lever", async () => {
    const { getSandbox, recorded } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", sleepAfter: "2m" })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.ids).toEqual(["run-1"])
    expect(recorded.options?.[0]).toMatchObject({ enableDefaultSession: false, sleepAfter: "2m" })
  })

  it("leaves sleepAfter to the SDK default when the caller names none", async () => {
    const { getSandbox, recorded } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1" })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.options[0]).not.toHaveProperty("sleepAfter")
  })

  it("runs and collects a command in exec mode", async () => {
    const { getSandbox, recorded } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", egress: { httpProxy: "http://p:1" } })
    )

    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      const started = yield* provider.spawn("bun test", {})
      const chunks = yield* Stream.runCollect(started.stdout)
      return { text: new TextDecoder().decode(chunks[0] ?? new Uint8Array()), code: yield* started.exitCode }
    })))

    expect(outcome).toEqual({ text: "exec-out", code: 0 })
    expect(recorded.execs.at(-1)?.env?.["HTTP_PROXY"]).toBe("http://p:1")
  })

  it("answers the same outcome in process mode as in exec mode", async () => {
    // The whole point of the mode: a detached start must not cost the caller
    // its output. Before the process log was read back, both streams were
    // empty and only the exit code survived.
    for (const command of ["greet", "complain", "boom"]) {
      expect(await ran("process", command), command).toEqual(await ran("exec", command))
    }
  })

  it("waits for a detached process instead of reporting its handle as a result", async () => {
    const { getSandbox, recorded } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", execution: "process" })
    )

    const code = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      const started = yield* provider.spawn("bun test", {})
      return yield* started.exitCode
    })))

    expect(recorded.started).toEqual(["bun test"])
    expect(recorded.waited).toEqual([true])
    expect(code).toBe(0)
  })

  it("reports a failing detached process's exit code", async () => {
    expect((await ran("process", "boom")).exitCode).toBe(3)
  })

  it("passes the shared session conformance suite in exec mode", async () => {
    const { getSandbox } = mockSdk()

    const violations = await Effect.runPromise(Conformance.check({
      open: CloudflareSandbox.session({ getSandbox, binding: {}, session: "run-1" }),
      probePath: "/workspace/.smithers/probe.txt",
      ...commands
    }))

    expect(Conformance.format(violations)).toBe("session conforms")
  })

  it("passes the shared session conformance suite in process mode", async () => {
    const { getSandbox } = mockSdk()

    const violations = await Effect.runPromise(Conformance.check({
      open: CloudflareSandbox.session({ getSandbox, binding: {}, session: "run-1", execution: "process" }),
      probePath: "/workspace/.smithers/probe.txt",
      ...commands
    }))

    expect(Conformance.format(violations)).toBe("session conforms")
  })

  it("passes the sandbox provider conformance suite", async () => {
    const { getSandbox } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1" })
    )

    const violations = await Effect.runPromise(ProviderConformance.check(provider, {
      writes: commands.writes,
      output: commands.output,
      fails: commands.fails,
      failureCode: commands.failureCode,
      runs: "serve"
    }))

    expect(ProviderConformance.format(violations)).toBe("provider conforms")
  })
})

describe("D1 descriptors", () => {
  it("refuses transactions, because D1 has no interactive transaction", async () => {
    const descriptor = D1.d1Descriptor({
      prepare: () => ({
        bind: () => ({
          all: () => Promise.resolve({ results: [{ id: 1 }] }),
          run: () => Promise.resolve(undefined)
        })
      })
    })

    expect(descriptor.supportsTransactions).toBe(false)
    expect(descriptor.transaction).toBeUndefined()
    expect(await descriptor.queryAllRaw("select 1")).toEqual([{ id: 1 }])
  })

  it("falls back to column values when D1 exposes no raw", async () => {
    const descriptor = D1.d1Descriptor({
      prepare: () => ({
        bind: () => ({
          all: () => Promise.resolve({ results: [{ a: 1, b: 2 }] }),
          run: () => Promise.resolve(undefined)
        })
      })
    })

    expect(await descriptor.queryValuesRaw("select 1")).toEqual([[1, 2]])
  })

  it("reports the transaction a Durable Object actually has", () => {
    const rows = [{ id: 1 }]
    const withTransaction = D1.durableObjectDescriptor({
      exec: () => rows,
      transaction: <A>(body: () => A) => body()
    })
    const without = D1.durableObjectDescriptor({ exec: () => rows })

    expect(withTransaction.supportsTransactions).toBe(true)
    expect(without.supportsTransactions).toBe(false)
  })
})
