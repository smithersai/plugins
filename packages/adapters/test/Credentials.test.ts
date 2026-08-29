/**
 * Where each vendor keeps a subscription credential, and the rule that keeps
 * one account from minting another's header.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Credentials from "../src/Credentials.ts"

let root = ""
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const run = <A, E>(body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(Effect.provide(body, platform) as Effect.Effect<A, E>)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smithers-creds-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Claude Code", () => {
  it("reads an OAuth credential out of the account's configuration directory", async () => {
    const credential = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        join(root, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "tok", expiresAt: 42, subscriptionType: "max" }
        })
      )
      return yield* Credentials.claude(fs, path, root)
    }))

    expect(credential).toEqual({ accessToken: "tok", expiresAt: 42, subscriptionType: "max" })
  })

  it("answers nothing for a missing or malformed credential", async () => {
    const missing = await run(Effect.gen(function*() {
      return yield* Credentials.claude(yield* FileSystem.FileSystem, yield* Path.Path, root)
    }))

    expect(missing).toBeUndefined()
    expect(Credentials.parseClaude({ claudeAiOauth: {} })).toBeUndefined()
    expect(Credentials.parseClaude("nope")).toBeUndefined()
  })

  it("never falls back to the default Keychain item for an isolated account", () => {
    const isolated = Credentials.claudeKeychainServices("/accounts/claude-2", "/home/.claude")
    const standard = Credentials.claudeKeychainServices(undefined, "/home/.claude")

    expect(isolated).toEqual([`Claude Code-credentials-${Credentials.claudeKeychainSuffix("/accounts/claude-2")}`])
    expect(isolated).not.toContain("Claude Code-credentials")
    expect(standard).toEqual(["Claude Code-credentials"])
  })

  it("derives a stable eight-hex Keychain suffix from the directory", () => {
    const suffix = Credentials.claudeKeychainSuffix("/accounts/claude-2")

    expect(suffix).toMatch(/^[0-9a-f]{8}$/)
    expect(Credentials.claudeKeychainSuffix("/accounts/claude-2")).toBe(suffix)
    expect(Credentials.claudeKeychainSuffix("/accounts/claude-3")).not.toBe(suffix)
  })
})

describe("Codex", () => {
  it("reads the account id from the token, or from the id token's claims", async () => {
    const claims = Buffer.from(JSON.stringify({ chatgpt_account_id: "acct-9" })).toString("base64url")
    const outcome = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        join(root, "auth.json"),
        JSON.stringify({ tokens: { access_token: "tok", id_token: `h.${claims}.s` } })
      )
      return yield* Credentials.codex(fs, path, root)
    }))

    expect(outcome).toEqual({ accessToken: "tok", accountId: "acct-9" })
    expect(Credentials.parseCodex({ tokens: { access_token: "t", account_id: "direct" } })?.accountId)
      .toBe("direct")
  })

  it("answers nothing for an API-key-only auth file", () => {
    expect(Credentials.parseCodex({ OPENAI_API_KEY: "sk" })).toBeUndefined()
  })
})

describe("Kimi", () => {
  it("reads a credential from the share directory", async () => {
    const credential = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        join(root, "auth.json"),
        JSON.stringify({ auth: { access_token: "tok", expires_at: 100 } })
      )
      return yield* Credentials.kimi(fs, path, root)
    }))

    expect(credential).toEqual({ accessToken: "tok", expiresAt: 100 })
  })
})

describe("decodeJwtClaims", () => {
  it("reads the payload without verifying the token", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "u-1" })).toString("base64url")

    expect(Credentials.decodeJwtClaims(`h.${payload}.s`)).toEqual({ sub: "u-1" })
  })

  it("answers nothing for a token it cannot read", () => {
    expect(Credentials.decodeJwtClaims("not-a-jwt")).toBeUndefined()
    expect(Credentials.decodeJwtClaims("h.%%%.s")).toBeUndefined()
  })
})

describe("expired", () => {
  it("refreshes early rather than failing a request in flight", () => {
    const credential = { accessToken: "t", expiresAt: 1_000_000 }

    expect(Credentials.expired(credential, 1_000_000 - 90_000)).toBe(false)
    expect(Credentials.expired(credential, 1_000_000 - 30_000)).toBe(true)
    expect(Credentials.expired({ accessToken: "t" })).toBe(false)
  })
})
