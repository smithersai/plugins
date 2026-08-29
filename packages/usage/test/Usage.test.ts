/**
 * Availability classification, quota-state persistence, and pool ordering.
 *
 * The quota store runs against a real file system in a temporary root: atomic
 * rename, mode 0600, expiry, and the never-shorten rule are all disk
 * behaviours a stub would not show.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Availability from "../src/Availability.ts"
import * as QuotaState from "../src/QuotaState.ts"
import * as Selection from "../src/Selection.ts"
import type { UsageReport, UsageWindow } from "../src/UsageReport.ts"

const now = Date.parse("2026-08-29T12:00:00.000Z")

const window = (input: Partial<UsageWindow> & Pick<UsageWindow, "id" | "label">): UsageWindow => ({
  unit: "percent",
  ...input
})

describe("Availability", () => {
  it("reports unknown when there is nothing to judge", () => {
    expect(Availability.classifyAccountAvailability([], now).status).toBe("unknown")
  })

  it("reports ok when every window has headroom", () => {
    const state = Availability.classifyAccountAvailability(
      [window({ id: "5h", label: "5-hour session", usedPercent: 42 })],
      now
    )

    expect(state).toEqual({ status: "ok", reasons: [] })
  })

  it("reports blocked when an account-wide window is exhausted", () => {
    const state = Availability.classifyAccountAvailability(
      [window({ id: "5h", label: "5-hour session", usedPercent: 100 })],
      now
    )

    expect(state).toEqual({ status: "blocked", reasons: ["5-hour session exhausted"] })
  })

  it("reports degraded when only a model-scoped window is exhausted", () => {
    const state = Availability.classifyAccountAvailability(
      [
        window({ id: "weekly", label: "weekly", usedPercent: 10 }),
        window({ id: "weekly-fable", label: "weekly fable", usedPercent: 100, modelScope: "fable" })
      ],
      now
    )

    expect(state).toEqual({ status: "degraded", reasons: ["weekly fable exhausted"] })
  })

  it("treats a window past its reset as rolled over", () => {
    const rolled = window({
      id: "5h",
      label: "5-hour session",
      usedPercent: 100,
      resetsAt: new Date(now - 1000).toISOString()
    })

    expect(Availability.effectiveUsedPercent(rolled, now)).toBe(0)
    expect(Availability.classifyAccountAvailability([rolled], now).status).toBe("ok")
  })

  it("reports blocked on an exhausted count window with no percentage", () => {
    const state = Availability.classifyAccountAvailability(
      [window({ id: "rpm", label: "requests per minute", unit: "count", limit: 10, used: 10, remaining: 0 })],
      now
    )

    expect(state.status).toBe("blocked")
  })
})

describe("Selection", () => {
  const account = (label: string, model?: string) => ({
    label,
    provider: "claude-code" as const,
    configDir: `/tmp/${label}`,
    ...(model === undefined ? {} : { model })
  })

  const report = (label: string, windows: ReadonlyArray<UsageWindow>): UsageReport => ({
    accountLabel: label,
    provider: "claude-code",
    authMode: "subscription",
    source: "oauth",
    windows,
    fetchedAt: new Date(now).toISOString(),
    stale: false,
    estimate: false
  })

  it("scores an unmeasured account worse than any measured one", () => {
    expect(Selection.accountUsageScore(undefined, undefined)).toBe(Selection.unknownScore)
    expect(Selection.accountUsageScore(report("a", [window({ id: "5h", label: "5h", usedPercent: 99 })]), undefined))
      .toBe(99)
  })

  it("normalizes shared weekly use against Fable's half-plan cap", () => {
    const score = Selection.accountUsageScore(
      report("a", [window({ id: "weekly", label: "weekly", usedPercent: 60 })]),
      "claude-fable-5"
    )

    expect(score).toBe(100)
  })

  it("orders by headroom and sends blocked accounts last, soonest reset first", () => {
    const ordered = Selection.orderAccountsByUsage(
      [account("busy"), account("fresh"), account("blocked-late"), account("blocked-soon")],
      {
        quota: {
          "blocked-late": { untilMs: now + 60_000, observedAt: "" },
          "blocked-soon": { untilMs: now + 1_000, observedAt: "" }
        },
        reports: {
          busy: report("busy", [window({ id: "5h", label: "5h", usedPercent: 80 })]),
          fresh: report("fresh", [window({ id: "5h", label: "5h", usedPercent: 3 })])
        },
        nowMs: now
      }
    ).map((entry) => entry.label)

    expect(ordered).toEqual(["fresh", "busy", "blocked-soon", "blocked-late"])
  })

  it("treats a fully used window as a block even with no recorded quota entry", () => {
    const block = Selection.accountQuotaBlock(
      {},
      "a",
      undefined,
      report("a", [
        window({ id: "5h", label: "5h", usedPercent: 100, resetsAt: new Date(now + 5_000).toISOString() })
      ]),
      now
    )

    expect(block?.untilMs).toBe(now + 5_000)
  })

  it("keeps a model-scoped block off another family", () => {
    const opus = Selection.accountQuotaBlock({ "a::opus": { untilMs: now + 1000, observedAt: "" } }, "a", "opus", undefined, now)
    const sonnet = Selection.accountQuotaBlock({ "a::opus": { untilMs: now + 1000, observedAt: "" } }, "a", "sonnet", undefined, now)

    expect(opus?.untilMs).toBe(now + 1000)
    expect(sonnet).toBeUndefined()
  })

  it("breaks a tie by the caller's map, then by label", () => {
    const ordered = Selection.orderAccountsByUsage([account("b"), account("a"), account("c")], {
      quota: {},
      tieBreak: new Map([["c", -1]]),
      nowMs: now
    }).map((entry) => entry.label)

    expect(ordered).toEqual(["c", "a", "b"])
  })
})

describe("QuotaState", () => {
  let root = ""

  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

  const run = <A, E>(body: Effect.Effect<A, E, QuotaState.QuotaStore | FileSystem.FileSystem | Path.Path>) =>
    Effect.runPromise(
      body.pipe(
        Effect.provide(
          QuotaState.layer.pipe(Layer.provideMerge(platform), Layer.provideMerge(QuotaState.layerRoot(root)))
        ),
        Effect.provide(platform)
      ) as Effect.Effect<A, E>
    )

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "smithers-usage-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("reads an empty state before the file exists", async () => {
    const state = await run(Effect.flatMap(QuotaState.QuotaStore, (store) => store.read(now)))

    expect(state).toEqual({ version: 1, entries: {} })
  })

  it("records a block and reads it back", async () => {
    const state = await run(Effect.gen(function*() {
      const store = yield* QuotaState.QuotaStore
      yield* store.record("claude-1", { untilMs: now + 10_000, nowMs: now })
      return yield* store.read(now)
    }))

    expect(state.entries["claude-1"]?.untilMs).toBe(now + 10_000)
  })

  it("gives a block with no provider reset a bounded time to live", async () => {
    const entry = await run(Effect.gen(function*() {
      const store = yield* QuotaState.QuotaStore
      return yield* store.record("claude-1", { nowMs: now })
    }))

    expect(entry.untilMs).toBe(now + QuotaState.unknownQuotaTtlMillis)
  })

  it("never shortens a block that already reaches further", async () => {
    const entry = await run(Effect.gen(function*() {
      const store = yield* QuotaState.QuotaStore
      yield* store.record("claude-1", { untilMs: now + 60_000, nowMs: now })
      return yield* store.record("claude-1", { untilMs: now + 1_000, nowMs: now })
    }))

    expect(entry.untilMs).toBe(now + 60_000)
  })

  it("keys a model-scoped block by family", async () => {
    const state = await run(Effect.gen(function*() {
      const store = yield* QuotaState.QuotaStore
      yield* store.record("claude-1", { untilMs: now + 1_000, model: "claude-opus-5", scope: "model", nowMs: now })
      return yield* store.read(now)
    }))

    expect(Object.keys(state.entries)).toEqual(["claude-1::opus"])
  })

  it("drops an expired block on read", async () => {
    const state = await run(Effect.gen(function*() {
      const store = yield* QuotaState.QuotaStore
      yield* store.record("claude-1", { untilMs: now + 1_000, nowMs: now })
      return yield* store.read(now + 2_000)
    }))

    expect(state.entries).toEqual({})
  })

  it("clears every block for a label, expired rows included", async () => {
    const outcome = await run(Effect.gen(function*() {
      const store = yield* QuotaState.QuotaStore
      yield* store.record("claude-1", { untilMs: now + 1_000, nowMs: now })
      yield* store.record("claude-1", { untilMs: now + 1_000, model: "opus", scope: "model", nowMs: now })
      const cleared = yield* store.clear("claude-1")
      const again = yield* store.clear("claude-1")
      const state = yield* store.read(now)
      return { cleared, again, entries: state.entries }
    }))

    expect(outcome).toEqual({ cleared: true, again: false, entries: {} })
  })

  it("answers an empty state for a corrupt file rather than failing the pool", async () => {
    const state = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const store = yield* QuotaState.QuotaStore
      yield* fs.writeFileString(yield* store.path, "{ not json")
      return yield* store.read(now)
    }))

    expect(state).toEqual({ version: 1, entries: {} })
  })
})
