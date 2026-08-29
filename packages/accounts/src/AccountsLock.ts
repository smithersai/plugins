/**
 * A cross-process advisory lock around the registry's read-modify-write.
 *
 * Smithers runs many CLIs at once, and both the wizard and the programmatic
 * API mutate the registry. Without a lock two callers read the same base state
 * and each rewrites the whole file, so the second rename silently drops the
 * first writer's account. This serializes those critical sections.
 *
 * The lock is an `O_EXCL` file beside the registry: only one process creates
 * it. A lock older than {@link staleMillis} is treated as orphaned and broken,
 * because a killed process must never wedge the registry permanently. Breaking
 * it renames the entry aside first and deletes it only once its inode proves it
 * is the file that was observed as stale — otherwise a successor's fresh lock,
 * created in the gap between the stat and the delete, would be destroyed.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { AccountsLocked } from "./AccountsError.ts"

/** How long an acquirer waits before it reports the lock as held. @since 1.0.0 */
export const timeoutMillis = 10_000

/** How old a lock must be before it is presumed orphaned. @since 1.0.0 */
export const staleMillis = 30_000

/** How long a waiter sleeps between acquisition attempts. @since 1.0.0 */
export const retryMillis = 5

let breakSequence = 0

const inodeOf = (info: FileSystem.File.Info): number | undefined =>
  info.ino._tag === "Some" ? info.ino.value : undefined

const mtimeOf = (info: FileSystem.File.Info): number | undefined =>
  info.mtime._tag === "Some" ? info.mtime.value.getTime() : undefined

/**
 * Runs `critical` while holding the lock beside `path`, releasing it on every
 * exit path including interruption.
 *
 * The lock is released only when the file at the lock path is still the exact
 * file this call created. If it was broken while the critical section ran, a
 * successor already holds a fresh lock and deleting it would admit a second
 * concurrent holder.
 *
 * @category combinators
 * @since 1.0.0
 */
export const withLock = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: string,
  critical: Effect.Effect<A, E, R>
): Effect.Effect<A, E | AccountsLocked, R> =>
  Effect.gen(function*() {
    const lockPath = `${path}.lock`
    const deadline = Date.now() + timeoutMillis

    const breakStale = Effect.gen(function*() {
      const observed = yield* Effect.result(fs.stat(lockPath))
      if (observed._tag === "Failure") return
      const mtime = mtimeOf(observed.success)
      if (mtime === undefined || Date.now() - mtime <= staleMillis) return
      const side = `${lockPath}.stale.${process.pid}.${breakSequence++}`
      const renamed = yield* Effect.result(fs.rename(lockPath, side))
      if (renamed._tag === "Failure") return
      const sideInfo = yield* Effect.result(fs.stat(side))
      if (sideInfo._tag === "Success" && inodeOf(sideInfo.success) === inodeOf(observed.success)) {
        yield* Effect.ignore(fs.remove(side, { force: true }))
        return
      }
      // A successor's fresh lock was moved aside. Put it back rather than
      // destroying a live holder's claim.
      const restored = yield* Effect.result(fs.rename(side, lockPath))
      if (restored._tag === "Failure") yield* Effect.ignore(fs.remove(side, { force: true }))
    })

    const acquire: Effect.Effect<number | undefined, AccountsLocked> = Effect.gen(function*() {
      for (;;) {
        const opened = yield* Effect.result(
          Effect.scoped(Effect.flatMap(
            fs.open(lockPath, { flag: "wx", mode: 0o600 }),
            (file) =>
              Effect.flatMap(
                file.write(new TextEncoder().encode(`${process.pid}\n${Date.now()}\n`)),
                () => file.stat
              )
          ))
        )
        if (opened._tag === "Success") return inodeOf(opened.success)
        if (Date.now() >= deadline) {
          return yield* Effect.fail(
            new AccountsLocked({
              path: lockPath,
              message:
                `Timed out acquiring the accounts lock at ${lockPath} after ${timeoutMillis}ms; another process may be holding it.`
            })
          )
        }
        yield* breakStale
        yield* Effect.sleep(retryMillis)
      }
    })

    const owned = yield* acquire
    return yield* Effect.ensuring(
      critical,
      Effect.gen(function*() {
        const current = yield* Effect.result(fs.stat(lockPath))
        if (current._tag !== "Success") return
        if (owned !== undefined && inodeOf(current.success) !== owned) return
        yield* Effect.ignore(fs.remove(lockPath, { force: true }))
      })
    )
  })
