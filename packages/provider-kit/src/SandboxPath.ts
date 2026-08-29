/**
 * Keeping a sandboxed path inside its root.
 *
 * Two checks, and both are needed. The lexical one rejects a path that escapes
 * by `..` before anything touches the disk. The symlink one resolves the
 * nearest existing ancestor of the target, because a symlinked parent
 * directory of a path that does not exist yet would otherwise smuggle a write
 * outside the root.
 *
 * @since 1.0.0
 */
import { Effect, Result } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ProviderKitError } from "./ProviderKitError.ts"

/**
 * Resolves a path against a sandbox root, refusing one that escapes it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = (
  path: Path.Path,
  rootDir: string,
  inputPath: string
): Result.Result<string, ProviderKitError> => {
  if (inputPath === "") {
    return Result.fail(new ProviderKitError({ code: "path_escape", message: "Path must be a non-empty string" }))
  }
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(rootDir, inputPath)
  const root = path.resolve(rootDir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return Result.fail(new ProviderKitError({ code: "path_escape", message: "Path escapes sandbox root" }))
  }
  return Result.succeed(resolved)
}

/**
 * Proves a resolved path stays inside the root once symbolic links are
 * followed.
 *
 * Walks up to the nearest existing ancestor: a path that does not exist yet is
 * legal, but the directory it would be created in must still be inside.
 *
 * @category assertions
 * @since 1.0.0
 */
export const assertWithinRoot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: string,
  resolvedPath: string
): Effect.Effect<void, ProviderKitError> =>
  Effect.gen(function*() {
    const rootReal = yield* fs.realPath(path.resolve(rootDir)).pipe(
      Effect.mapError(() =>
        new ProviderKitError({ code: "path_escape", message: `Sandbox root ${rootDir} does not resolve` })
      )
    )
    let current = resolvedPath
    for (;;) {
      const real = yield* Effect.result(fs.realPath(current))
      if (real._tag === "Success") {
        const target = real.success
        if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
          return yield* Effect.fail(
            new ProviderKitError({
              code: "path_escape",
              message: "Path escapes sandbox root (via symlink)"
            })
          )
        }
        return
      }
      const parent = path.dirname(current)
      if (parent === current) {
        return yield* Effect.fail(
          new ProviderKitError({ code: "path_escape", message: "Path has no existing ancestor inside the root" })
        )
      }
      current = parent
    }
  })
