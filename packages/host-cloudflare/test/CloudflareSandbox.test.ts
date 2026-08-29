/**
 * The Cloudflare host: `sleepAfter` pass-through, both execution modes, and
 * the D1 transaction refusal.
 *
 * Process mode is the one worth the test. A detached start answers with a pid,
 * and reporting that as a finished run is a silent success trap: the caller
 * gets nothing back and never learns the command failed.
 */
import { Effect, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as CloudflareSandbox from "../src/CloudflareSandbox.ts"
import * as D1 from "../src/D1.ts"
import type * as Sdk from "../src/Sdk.ts"

interface Recorded {
  readonly ids: Array<string>
  readonly options: Array<Parameters<Sdk.GetSandbox>[2]>
  readonly execs: Array<{ command: string; cwd?: string; env?: Readonly<Record<string, string>> }>
  readonly started: Array<string>
  readonly waited: Array<true>
}

const mockSdk = (
  overrides: { readonly exitCode?: number; readonly startProcess?: boolean } = {}
): { readonly getSandbox: Sdk.GetSandbox; readonly recorded: Recorded } => {
  const recorded: Recorded = { ids: [], options: [], execs: [], started: [], waited: [] }
  const getSandbox: Sdk.GetSandbox = (_binding, id, options) => {
    recorded.ids.push(id)
    recorded.options.push(options)
    const sandbox: Sdk.Sandbox = {
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      readFile: () => Promise.resolve({ content: "result" }),
      exec: (command, execOptions) => {
        recorded.execs.push({ command, ...execOptions })
        return Promise.resolve({ exitCode: 0, stdout: "exec-out", stderr: "" })
      },
      ...(overrides.startProcess === false ? {} : {
        startProcess: (command) => {
          recorded.started.push(command)
          return Promise.resolve({
            pid: 42,
            waitForExit: () => {
              recorded.waited.push(true)
              return Promise.resolve({ exitCode: overrides.exitCode ?? 0 })
            }
          })
        }
      })
    }
    return sandbox
  }
  return { getSandbox, recorded }
}

describe("CloudflareSandbox", () => {
  it("passes sleepAfter through, because it is the container cost lever", async () => {
    const { getSandbox, recorded } = mockSdk()
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", sleepAfter: "2m" })
    )

    await Effect.runPromise(Effect.scoped(provider.open("run-1")))

    expect(recorded.ids).toEqual(["run-1"])
    expect(recorded.options[0]).toMatchObject({ enableDefaultSession: false, sleepAfter: "2m" })
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

  it("waits for a detached process instead of reporting its pid as a result", async () => {
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
    const { getSandbox } = mockSdk({ exitCode: 3 })
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", execution: "process" })
    )

    const code = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      const started = yield* provider.spawn("bun test", {})
      return yield* started.exitCode
    })))

    expect(code).toBe(3)
  })

  it("fails process mode when the SDK exposes no startProcess", async () => {
    const { getSandbox } = mockSdk({ startProcess: false })
    const provider = Result.getOrThrow(
      CloudflareSandbox.make({ getSandbox, binding: {}, session: "run-1", execution: "process" })
    )

    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      return yield* Effect.result(provider.spawn("bun test", {}))
    })))

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("startProcess")
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
