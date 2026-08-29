/**
 * The runner, against real processes.
 *
 * These spawn `node` rather than a vendor binary: what is under test is the
 * runner — argv, environment precedence, line decoding through the spec's own
 * reader, and classification of a non-zero exit — and a scripted process makes
 * every one of those observable without a subscription.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { ContainedSpawner, ProcessLedger } from "@smthrs/kernel"
import { Effect, Fiber, Layer, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as CliClassifier from "../src/CliClassifier.ts"
import type { CliRecord } from "../src/CliOutput.ts"
import * as CliRun from "../src/CliRun.ts"
import { HarnessCapabilities } from "../src/HarnessCapabilities.ts"
import type * as Spec from "../src/Spec.ts"

const spawner = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const run = <A, E>(body: Effect.Effect<A, E, never>) => Effect.runPromise(body)

// The runner never reads `process.env`: the caller owns the child's whole
// environment, which is what makes an account's isolation variable
// unspoofable. A caller that wants a binary found on PATH passes PATH.
const path = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "" })

/**
 * A spec whose "binary" is node running a script the test supplies. Everything
 * else — the reader, the patterns, the capabilities — is a real adapter's
 * shape.
 */
const scripted = (script: string): Spec.Spec => ({
  capabilities: new HarnessCapabilities({
    name: "scripted",
    version: "1",
    resume: "flag",
    mcpBootstrap: "none",
    skillsInstall: "none",
    configDirIsolation: true,
    nativeStructuredOutput: false,
    steer: false,
    images: false,
    usage: false
  }),
  patterns: CliClassifier.defaultPatterns,
  buildCommand: (options, resume) => ({
    command: "node",
    args: [
      "-e",
      script,
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(resume === undefined ? [] : ["--session", resume.sessionId]),
      ...(options.prompt === undefined ? [] : [options.prompt])
    ],
    cleanup: [],
    env: { SCRIPTED_ADAPTER: "1" }
  }),
  interpret: (line): CliRecord | null => {
    if (typeof line !== "object" || line === null) return null
    const value = line as Record<string, unknown>
    if (value["type"] === "session" && typeof value["id"] === "string") {
      return { type: "resumeToken", sessionId: value["id"] }
    }
    if (value["type"] === "result" && typeof value["text"] === "string") {
      return { type: "settled", assistantText: value["text"] }
    }
    return null
  }
})

const emit = (records: ReadonlyArray<unknown>, exitCode = 0, stderr = "") =>
  `${records.map((record) => `console.log(${JSON.stringify(JSON.stringify(record))})`).join(";")};` +
  (stderr === "" ? "" : `console.error(${JSON.stringify(stderr)});`) +
  `process.exit(${exitCode})`

describe("CliRun.render", () => {
  it("leaves prompt placement to the adapter", () => {
    const rendered = CliRun.render(scripted("0"), { prompt: "do the thing", model: "m" })

    expect(rendered.args.at(-1)).toBe("do the thing")
    expect(rendered.args).toContain("--model")
  })

  it("keeps every fresh flag on a resumed command", () => {
    const options = { prompt: "p", model: "m" }
    const fresh = CliRun.render(scripted("0"), options)
    const resumed = CliRun.render(scripted("0"), { ...options, resume: { sessionId: "s-1" } })

    expect(fresh.args.filter((argument) => argument.startsWith("--")).every((flag) =>
      resumed.args.includes(flag)
    )).toBe(true)
  })
})

describe("CliRun.run", () => {
  it("decodes the vendor's records and resolves the answer", async () => {
    const outcome = await run(
      CliRun.run(
        scripted(emit([{ type: "session", id: "s-7" }, { type: "result", text: "the answer" }])),
        { prompt: "p", env: path() }
      ).pipe(Effect.provide(spawner))
    )

    expect(outcome.exitCode).toBe(0)
    expect(outcome.answer).toBe("the answer")
    expect(outcome.sessionId).toBe("s-7")
    expect(outcome.records).toHaveLength(2)
  })

  it("lets the spec's environment win over the caller's", async () => {
    const outcome = await run(
      CliRun.run(
        scripted(
          `console.log(JSON.stringify({type:"result",text:process.env.SCRIPTED_ADAPTER}));process.exit(0)`
        ),
        { prompt: "p", env: { ...path(), SCRIPTED_ADAPTER: "hijacked" } }
      ).pipe(Effect.provide(spawner))
    )

    expect(outcome.answer).toBe("1")
  })

  it("classifies a quota refusal rather than reporting a generic failure", async () => {
    const outcome = await run(
      Effect.result(
        CliRun.run(scripted(emit([], 1, "Claude usage limit exceeded")), { prompt: "p", env: path() }).pipe(
          Effect.provide(spawner)
        )
      )
    )

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure._tag : "").toBe(
      "@smthrs-plugins/adapters/QuotaExhausted"
    )
  })

  it("never reports a non-zero exit with no diagnostics as a success", async () => {
    const outcome = await run(
      Effect.result(CliRun.run(scripted(emit([], 3)), { prompt: "p", env: path() }).pipe(Effect.provide(spawner)))
    )

    expect(outcome._tag).toBe("Failure")
  })

  it("reports a missing binary as a spawn failure", async () => {
    const missing: Spec.Spec = {
      ...scripted("0"),
      buildCommand: () => ({
        command: "definitely-not-a-real-binary-smithers",
        args: [],
        cleanup: [],
        env: {}
      })
    }
    const outcome = await run(
      Effect.result(CliRun.run(missing, { prompt: "p", env: path() }).pipe(Effect.provide(spawner)))
    )

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure._tag : "").toBe(
      "@smthrs-plugins/adapters/SpawnFailed"
    )
  })

  // Codex 0.150.1 reads standard input even when the prompt is the positional
  // argument ("If stdin is piped and a prompt is also provided, stdin is
  // appended as a `<stdin>` block"), and it announces "Reading additional input
  // from stdin..." before it will start the turn. A child handed an open pipe
  // nobody writes to therefore never settles, which is exactly what the live
  // smoke hit: every codex turn timed out at three minutes. A spec that asks
  // for no stdin must get a closed one.
  it("closes the child's standard input when the spec sends none", async () => {
    const outcome = await run(
      CliRun.run(
        scripted(
          `let seen="";process.stdin.on("data",(c)=>{seen+=c});` +
            `process.stdin.on("end",()=>{console.log(JSON.stringify({type:"result",text:"eof:"+seen.length}));process.exit(0)})`
        ),
        { prompt: "p", env: path() }
      ).pipe(Effect.provide(spawner))
    )

    expect(outcome.answer).toBe("eof:0")
  }, 15_000)

  it("still pipes the standard input a spec does ask for", async () => {
    const reader: Spec.Spec = {
      ...scripted("0"),
      buildCommand: () => ({
        command: "node",
        args: [
          "-e",
          `let seen="";process.stdin.on("data",(c)=>{seen+=c});` +
            `process.stdin.on("end",()=>{console.log(JSON.stringify({type:"result",text:seen}));process.exit(0)})`
        ],
        cleanup: [],
        env: {},
        stdin: "from the spec"
      })
    }
    const outcome = await run(
      CliRun.run(reader, { prompt: "p", env: path() }).pipe(Effect.provide(spawner))
    )

    expect(outcome.answer).toBe("from the spec")
  }, 15_000)

  it("falls back to the stdout tail when the vendor emitted no settled record", async () => {
    const outcome = await run(
      CliRun.run(scripted(`console.log("bare prose");process.exit(0)`), { prompt: "p", env: path() }).pipe(
        Effect.provide(spawner)
      )
    )

    expect(outcome.answer).toContain("bare prose")
  })
})

describe("CliRun.stream", () => {
  it("streams decoded records as the process produces them", async () => {
    const records = await run(
      Stream.runCollect(
        CliRun.stream(
          scripted(emit([{ type: "session", id: "s-1" }, { type: "result", text: "done" }])),
          { prompt: "p", env: path() }
        )
      ).pipe(Effect.provide(spawner))
    )

    expect(records.map((record) => record.type)).toEqual(["resumeToken", "settled"])
  })
})

describe("CliRun.probe", () => {
  it("reports the exit status of a short command", async () => {
    const answered = await run(
      Effect.gen(function*() {
        const probe = yield* CliRun.probe
        return yield* probe.exec("node --version")
      }).pipe(Effect.provide(spawner))
    )

    expect(answered.exitCode).toBe(0)
    expect(answered.stdout).toMatch(/^v\d+/)
  })

  it("fails typed when the command cannot run at all", async () => {
    const outcome = await run(
      Effect.result(
        Effect.gen(function*() {
          const probe = yield* CliRun.probe
          return yield* probe.exec("definitely-not-a-real-binary-smithers --version")
        }).pipe(Effect.provide(spawner))
      )
    )

    expect(outcome._tag).toBe("Failure")
  })
})

/**
 * Containment is the kernel's, and this is the case that says so.
 *
 * The runner spawns; it does not signal, detach, or reap. Process groups,
 * `SIGTERM` escalation and the durable record of a live child belong to
 * `@smthrs/kernel`'s `ContainedSpawner`, which a host composes over its
 * platform spawner. The 0.x adapters owned that themselves
 * (`run-command-process-group`, `run-command-parent-death`,
 * `parent-death-watchdog-cwd`), so the requirement those suites expressed has
 * to be visible from here: a cancelled `CliRun.run` must leave nothing behind,
 * including the grandchild nobody holds a handle for.
 *
 * `sh` is the binary because a background job is the shortest way to make a
 * process the runner never saw, and the tree ignores `SIGTERM` so the case can
 * only pass on the escalation the containment layer supplies. Effect's own Node
 * spawner already signals the group on scope close, but with `SIGTERM` alone
 * and then an unbounded wait: swap `contained` for `spawner` below and the
 * interrupt never returns, which is the hung host `ContainedSpawner` exists to
 * prevent.
 */
const containmentDirectory = mkdtempSync(join(tmpdir(), "smithers-adapters-contained-"))

afterAll(() => rmSync(containmentDirectory, { recursive: true, force: true }))

/** Waits for a pid to disappear, or gives up after `budgetMs`. */
const waitForExit = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

/** Waits for the shell to report its own pid and its background job's. */
const waitForPidFile = async (path: string): Promise<ReadonlyArray<number>> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      const parts = readFileSync(path, "utf8").trim().split(/\s+/).filter((part) => part !== "")
      if (parts.length === 2) return parts.map(Number)
    } catch {
      // not written yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the shell never wrote ${path}`)
}

/** A spec whose binary is a shell that forks a job the runner never sees. */
const forking = (script: string): Spec.Spec => ({
  ...scripted("0"),
  buildCommand: () => ({ command: "sh", args: ["-c", script], cleanup: [], env: {} })
})

const contained = ContainedSpawner.layer({ graceMs: 400 }).pipe(
  Layer.provide(spawner),
  Layer.provide(ProcessLedger.layerMemory({ hostId: "adapters-contained", ownerPid: process.pid }))
)

describe("CliRun.run under the kernel's contained spawner", () => {
  it("leaves no process group behind when the run is interrupted", async () => {
    const pidFile = join(containmentDirectory, "group.pid")
    const spec = forking(
      `trap "" TERM; sleep 30 & echo "$$ $!" > ${pidFile}; while true; do sleep 0.2; done`
    )

    await run(
      Effect.gen(function*() {
        const fiber = yield* CliRun.run(spec, { prompt: "p", env: path() }).pipe(
          Effect.provide(contained),
          Effect.forkChild({ startImmediately: true })
        )
        const [shell, grandchild] = yield* Effect.promise(() => waitForPidFile(pidFile))

        yield* Fiber.interrupt(fiber)

        // The shell is the child the runner spawned; the background `sleep` is
        // the process nothing ever held a handle for. Both ignore `SIGTERM`, so
        // both are only reclaimed by the group `SIGKILL` the containment
        // deadline schedules.
        expect(yield* Effect.promise(() => waitForExit(shell!, 5_000))).toBe(true)
        expect(yield* Effect.promise(() => waitForExit(grandchild!, 5_000))).toBe(true)
      })
    )
  }, 30_000)
})
