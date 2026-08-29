/**
 * The runner, against real processes.
 *
 * These spawn `node` rather than a vendor binary: what is under test is the
 * runner — argv, environment precedence, line decoding through the spec's own
 * reader, and classification of a non-zero exit — and a scripted process makes
 * every one of those observable without a subscription.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
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
