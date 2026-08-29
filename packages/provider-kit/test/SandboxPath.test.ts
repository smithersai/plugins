/**
 * Sandbox path containment, lexically and through symbolic links.
 *
 * The symlink half runs against a real file system with real links: the escape
 * it prevents is only observable once a link is followed.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer, Result } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as SandboxPath from "../src/SandboxPath.ts"

let root = ""
let outside = ""

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const run = <A, E>(body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(Effect.provide(body, platform) as Effect.Effect<A, E>)

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "smithers-sandbox-path-"))
  root = join(base, "root")
  outside = join(base, "outside")
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe("SandboxPath.resolve", () => {
  it("resolves a relative path against the root", async () => {
    const resolved = await run(Effect.map(Path.Path, (path) =>
      Result.getOrThrow(SandboxPath.resolve(path, root, "src/index.ts"))))

    expect(resolved).toBe(join(root, "src/index.ts"))
  })

  it("refuses a path that climbs out with ..", async () => {
    const outcome = await run(Effect.map(Path.Path, (path) => SandboxPath.resolve(path, root, "../outside/x")))

    expect(outcome._tag).toBe("Failure")
  })

  it("refuses an absolute path outside the root", async () => {
    const outcome = await run(Effect.map(Path.Path, (path) => SandboxPath.resolve(path, root, outside)))

    expect(outcome._tag).toBe("Failure")
  })

  it("refuses an empty path", async () => {
    const outcome = await run(Effect.map(Path.Path, (path) => SandboxPath.resolve(path, root, "")))

    expect(outcome._tag).toBe("Failure")
  })

  it("accepts the root itself", async () => {
    const resolved = await run(Effect.map(Path.Path, (path) =>
      Result.getOrThrow(SandboxPath.resolve(path, root, "."))))

    expect(resolved).toBe(root)
  })
})

describe("SandboxPath.assertWithinRoot", () => {
  it("accepts a path inside the root", async () => {
    const outcome = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(join(root, "src"), { recursive: true })
      return yield* Effect.result(SandboxPath.assertWithinRoot(fs, path, root, join(root, "src/new.ts")))
    }))

    expect(outcome._tag).toBe("Success")
  })

  it("refuses a path whose parent directory is a link out of the root", async () => {
    symlinkSync(outside, join(root, "escape"))

    const outcome = await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // The file does not exist yet, which is exactly the case a lexical check
      // cannot see: the link is on its parent.
      return yield* Effect.result(SandboxPath.assertWithinRoot(fs, path, root, join(root, "escape/loot.txt")))
    }))

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("symlink")
  })
})
