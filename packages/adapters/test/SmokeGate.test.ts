/**
 * What the live smoke is allowed to conclude, pinned against real processes.
 *
 * The live smoke itself cannot assert this: it needs a subscription, and the
 * outcome under test is precisely the one where no turn is ever spent. So the
 * policy the smoke applies lives in {@link module:SmokeGate}, and this suite
 * drives it with real subprocesses standing in for the vendor binaries.
 *
 * The class being pinned is the false green. A seat whose login has lapsed or
 * whose quota is spent is a fact about the machine, so a run where every seat
 * refuses skips. A seat that starts and then hangs is a fact about the
 * adapter, so a run where nothing answered and something hung fails. Merging
 * the two lets an all-hang run report green with zero turns.
 */
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as CliClassifier from "../src/CliClassifier.ts"
import type { CliRecord } from "../src/CliOutput.ts"
import { HarnessCapabilities } from "../src/HarnessCapabilities.ts"
import type * as Spec from "../src/Spec.ts"
import * as SmokeGate from "./SmokeGate.ts"

const workspace = mkdtempSync(join(tmpdir(), "smoke-gate-"))

const options = (budgetMillis: number): SmokeGate.SeatOptions => ({
  prompt: "Reply with exactly the word: ready",
  env: { PATH: process.env["PATH"] ?? "" },
  cwd: workspace,
  budgetMillis
})

/** A spec whose "binary" is node running a script this file supplies. */
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
  buildCommand: (options) => ({
    command: "node",
    args: ["-e", script, ...(options.prompt === undefined ? [] : [options.prompt])],
    cleanup: [],
    env: { PATH: process.env["PATH"] ?? "" }
  }),
  interpret: (line): CliRecord | null => {
    if (typeof line !== "object" || line === null) return null
    const value = line as Record<string, unknown>
    return value["type"] === "result" && typeof value["text"] === "string"
      ? { type: "settled", assistantText: value["text"] }
      : null
  }
})

// Sleeps past any budget this suite sets, then exits on its own so a leaked
// child cannot outlive the run.
const hangs = scripted("setTimeout(() => process.exit(0), 5000)")
const answers = scripted(`console.log(JSON.stringify({ type: "result", text: "ready" }));process.exit(0)`)
const spent = scripted(`console.error("Claude usage limit exceeded");process.exit(1)`)

/** A `ctx` that records a skip instead of aborting, so a skip is observable. */
const recorder = () => {
  const skips: Array<string> = []
  return { skips, ctx: { skip: (reason: string) => { skips.push(reason); throw new Error("skipped") } } }
}

describe("SmokeGate", () => {
  it("classifies a seat that never finishes inside the budget as a hang", async () => {
    const outcome = await SmokeGate.attempt(hangs, "/seats/one", options(400))

    expect(outcome._tag).toBe("TimedOut")
  }, 30_000)

  it("classifies a spent seat as spent and an answering seat as answered", async () => {
    const refused = await SmokeGate.attempt(spent, "/seats/one", options(20_000))
    const answered = await SmokeGate.attempt(answers, "/seats/two", options(20_000))

    expect(refused._tag).toBe("Spent")
    expect(answered._tag).toBe("Answered")
    expect(answered._tag === "Answered" ? answered.answer.trim() : "").toBe("ready")
  }, 30_000)

  it("fails the run when no seat answered and a seat hung", async () => {
    const attempts = await SmokeGate.attemptSeats(hangs, ["/seats/one", "/seats/two"], options(400))

    const decided = SmokeGate.verdict("claude", attempts)

    // A hang stops the loop: it is the run's answer, not a rung to step over.
    expect(attempts.length).toBe(1)
    expect(decided._tag).toBe("Fail")
    expect(decided._tag === "Fail" ? decided.reason : "").toContain("/seats/one")
  }, 30_000)

  it("still fails when a spent seat is followed by a hung one, naming both", async () => {
    const refused = await SmokeGate.attempt(spent, "/seats/one", options(20_000))
    const hung = await SmokeGate.attempt(hangs, "/seats/two", options(400))

    const decided = SmokeGate.verdict("claude", [refused, hung])

    expect(decided._tag).toBe("Fail")
    expect(decided._tag === "Fail" ? decided.reason : "").toContain("/seats/two")
    expect(decided._tag === "Fail" ? decided.reason : "").toContain("/seats/one")
  }, 30_000)

  it("skips the run when every seat is spent, naming each refusal", async () => {
    const attempts = await SmokeGate.attemptSeats(spent, ["/seats/one", "/seats/two"], options(20_000))

    const decided = SmokeGate.verdict("claude", attempts)

    expect(decided._tag).toBe("Skip")
    expect(decided._tag === "Skip" ? decided.reason : "").toContain("QuotaExhausted")
  }, 30_000)

  it("stops at the first seat that answers", async () => {
    const attempts = await SmokeGate.attemptSeats(answers, ["/seats/one", "/seats/two"], options(20_000))

    expect(attempts.length).toBe(1)
    expect(SmokeGate.verdict("claude", attempts)._tag).toBe("Answered")
  }, 30_000)

  it("throws rather than skipping when the run hung, so a zero-turn run is never green", async () => {
    const attempts = await SmokeGate.attemptSeats(hangs, ["/seats/one"], options(400))
    const { ctx, skips } = recorder()

    expect(() => SmokeGate.settle(ctx, "claude", attempts)).toThrow(/never finished/)
    expect(skips).toEqual([])
  }, 30_000)

  it("skips through the context when every seat is spent", async () => {
    const attempts = await SmokeGate.attemptSeats(spent, ["/seats/one"], options(20_000))
    const { ctx, skips } = recorder()

    expect(() => SmokeGate.settle(ctx, "claude", attempts)).toThrow(/skipped/)
    expect(skips.length).toBe(1)
    expect(skips[0]).toContain("no seat answered")
  }, 30_000)

  it("fails a run that tried no seat at all", () => {
    expect(SmokeGate.verdict("claude", [])._tag).toBe("Fail")
  })

  it("fails on an adapter failure that is not a spent seat", async () => {
    const broken = scripted(`console.error("segmentation fault");process.exit(3)`)
    const attempts = await SmokeGate.attemptSeats(broken, ["/seats/one"], options(20_000))

    expect(SmokeGate.verdict("claude", attempts)._tag).toBe("Fail")
  }, 30_000)
})
