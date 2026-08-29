/**
 * The account registry over a real file system in a temporary root.
 *
 * These run against `@effect/platform-node`'s file system rather than a mock:
 * the behaviours worth pinning are atomic rename, mode 0600, lock-serialized
 * read-modify-write, and preservation of rows this build cannot parse, and
 * none of those are observable through a stub.
 */
import { Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Accounts from "../src/Accounts.ts"
import * as ProviderEnv from "../src/ProviderEnv.ts"

let root = ""

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const run = <A, E>(body: Effect.Effect<A, E, Accounts.Accounts | FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(Accounts.layer.pipe(Layer.provideMerge(platform), Layer.provideMerge(Accounts.layerConfig(root)))),
      Effect.provide(platform)
    ) as Effect.Effect<A, E>
  )

const claude = (label: string) => ({ label, provider: "claude-code" as const, configDir: `/tmp/${label}` })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smithers-accounts-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Accounts", () => {
  it("answers an empty registry before the file exists", async () => {
    const listed = await run(Effect.flatMap(Accounts.Accounts, (accounts) => accounts.list))

    expect(listed).toEqual([])
  })

  it("adds an account and reads it back", async () => {
    const added = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      const persisted = yield* accounts.add(claude("claude-1"), { now: "2026-08-29T00:00:00.000Z" })
      const listed = yield* accounts.list
      return { persisted, listed }
    }))

    expect(added.persisted.addedAt).toBe("2026-08-29T00:00:00.000Z")
    expect(added.listed).toEqual([{
      label: "claude-1",
      provider: "claude-code",
      configDir: "/tmp/claude-1",
      addedAt: "2026-08-29T00:00:00.000Z"
    }])
  })

  it("writes the registry file mode 0600 because it may hold a key", async () => {
    const mode = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* accounts.add({ label: "openai", provider: "openai-api", apiKey: "sk-secret" })
      const fs = yield* FileSystem.FileSystem
      const info = yield* fs.stat(yield* accounts.path)
      return info.mode & 0o777
    }))

    expect(mode).toBe(0o600)
  })

  it("refuses a duplicate label unless replace is set", async () => {
    const outcome = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* accounts.add(claude("claude-1"))
      const duplicate = yield* Effect.result(accounts.add(claude("claude-1")))
      const replaced = yield* accounts.add(
        { ...claude("claude-1"), model: "opus" },
        { replace: true }
      )
      return { duplicate, replaced }
    }))

    expect(outcome.duplicate._tag).toBe("Failure")
    expect(outcome.replaced.model).toBe("opus")
  })

  it("keeps the original addedAt when an account is replaced", async () => {
    const replaced = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* accounts.add(claude("claude-1"), { now: "2020-01-01T00:00:00.000Z" })
      return yield* accounts.add({ ...claude("claude-1"), model: "opus" }, { replace: true })
    }))

    expect(replaced.addedAt).toBe("2020-01-01T00:00:00.000Z")
  })

  it("refuses an account that sets both configDir and apiKey", async () => {
    const outcome = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      return yield* Effect.result(
        accounts.add({ label: "x", provider: "claude-code", configDir: "/tmp/x", apiKey: "k" })
      )
    }))

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure._tag : "").toContain("AccountInvalid")
  })

  it("removes an account and reports absence", async () => {
    const outcome = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* accounts.add(claude("claude-1"))
      const removed = yield* accounts.remove("claude-1")
      const again = yield* Effect.result(accounts.remove("claude-1"))
      const silent = yield* accounts.remove("claude-1", { silent: true })
      return { removed, again, silent }
    }))

    expect(outcome.removed).toBe(true)
    expect(outcome.again._tag).toBe("Failure")
    expect(outcome.silent).toBe(false)
  })

  it("preserves a row whose provider this build does not recognize", async () => {
    const written = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const accounts = yield* Accounts.Accounts
      yield* fs.writeFileString(
        yield* accounts.path,
        JSON.stringify({
          version: 1,
          accounts: [{ label: "legacy", provider: "gemini", configDir: "/tmp/legacy" }]
        })
      )
      yield* accounts.add(claude("claude-1"))
      return JSON.parse(yield* fs.readFileString(yield* accounts.path)) as {
        accounts: ReadonlyArray<{ label: string; provider: string }>
      }
    }))

    expect(written.accounts.map((row) => row.label)).toEqual(["claude-1", "legacy"])
    expect(written.accounts[1]?.provider).toBe("gemini")
  })

  it("removes a preserved unrecognized row by label", async () => {
    const remaining = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const accounts = yield* Accounts.Accounts
      yield* fs.writeFileString(
        yield* accounts.path,
        JSON.stringify({ version: 1, accounts: [{ label: "legacy", provider: "gemini" }] })
      )
      const removed = yield* accounts.remove("legacy")
      const raw = JSON.parse(yield* fs.readFileString(yield* accounts.path)) as { accounts: ReadonlyArray<unknown> }
      return { removed, count: raw.accounts.length }
    }))

    expect(remaining).toEqual({ removed: true, count: 0 })
  })

  it("serializes concurrent adds so neither is lost", async () => {
    const labels = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* Effect.all(
        [accounts.add(claude("claude-1")), accounts.add(claude("claude-2")), accounts.add(claude("claude-3"))],
        { concurrency: 3 }
      )
      return (yield* accounts.list).map((entry) => entry.label).sort()
    }))

    expect(labels).toEqual(["claude-1", "claude-2", "claude-3"])
  })

  it("fails a read of a corrupt registry rather than answering an empty one", async () => {
    const outcome = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const accounts = yield* Accounts.Accounts
      yield* fs.writeFileString(yield* accounts.path, "{ not json")
      return yield* Effect.result(accounts.list)
    }))

    expect(outcome._tag).toBe("Failure")
  })
})

describe("ProviderEnv", () => {
  it("maps every subscription provider onto its configuration variable", () => {
    const mapped = ([
      ["claude-code", "CLAUDE_CONFIG_DIR"],
      ["antigravity", "GEMINI_DIR"],
      ["codex", "CODEX_HOME"],
      ["kimi", "KIMI_SHARE_DIR"],
      ["grok", "GROK_HOME"]
    ] as const).map(([provider, variable]) => {
      const result = ProviderEnv.accountToProviderEnv({ label: provider, provider, configDir: "/dir" })
      return result._tag === "Success" ? result.success[variable] : undefined
    })

    expect(mapped).toEqual(["/dir", "/dir", "/dir", "/dir", "/dir"])
  })

  it("maps an API account onto its key variable and omits an empty key", () => {
    const set = ProviderEnv.accountToProviderEnv({ label: "a", provider: "openai-api", apiKey: "sk" })
    const empty = ProviderEnv.accountToProviderEnv({ label: "a", provider: "openai-api", apiKey: "" })

    expect(set._tag === "Success" ? set.success : {}).toEqual({ OPENAI_API_KEY: "sk" })
    expect(empty._tag === "Success" ? empty.success : {}).toEqual({})
  })

  it("refuses a subscription account with no configuration directory", () => {
    const result = ProviderEnv.accountToProviderEnv({ label: "a", provider: "codex" })

    expect(result._tag).toBe("Failure")
  })
})
