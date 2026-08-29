/**
 * The persisted record of which accounts a provider has rate-limited.
 *
 * A provider that answers "you are out of quota until 14:00" tells the pool
 * something no probe can: the account is dead, and re-probing it before the
 * reset costs a request and learns nothing. This service writes that fact to
 * `account-quota-state.json` beside the registry, so the next process starts
 * from what the last one learned instead of hammering the same account.
 *
 * Every entry expires. A block with no provider-supplied reset gets a short
 * bounded time to live, which stops the hammering without permanently
 * disabling an account whose limit has since cleared.
 *
 * @since 1.0.0
 */
import type { AccountsLocked } from "@smthrs-plugins/accounts/AccountsError"
import * as AccountsLock from "@smthrs-plugins/accounts/AccountsLock"
import { Context, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import type { PlatformError } from "effect/PlatformError"
import * as Path from "effect/Path"
import { modelFamily } from "./ModelFamily.ts"

/** How long a block with no provider reset lasts. @since 1.0.0 */
export const unknownQuotaTtlMillis = 5 * 60_000

/**
 * One recorded quota block.
 *
 * @category models
 * @since 1.0.0
 */
export interface QuotaEntry {
  /** Epoch milliseconds at which the account becomes usable again. */
  readonly untilMs: number
  /** The model the limit was observed on, when the provider named one. */
  readonly model?: string | undefined
  /** ISO-8601 timestamp of the observation. */
  readonly observedAt: string
}

/**
 * The parsed quota-state file.
 *
 * @category models
 * @since 1.0.0
 */
export interface QuotaState {
  readonly version: 1
  /** Keyed by label, or `label::family` for a model-scoped block. */
  readonly entries: Readonly<Record<string, QuotaEntry>>
}

/**
 * Quota-state operations.
 *
 * @category services
 * @since 1.0.0
 */
export interface Service {
  readonly path: Effect.Effect<string>
  /** Reads the live blocks, dropping expired and malformed rows. */
  readonly read: (nowMs?: number) => Effect.Effect<QuotaState, PlatformError>
  /** Records a block, never shortening one that already reaches further. */
  readonly record: (
    label: string,
    options?: {
      readonly untilMs?: number | undefined
      readonly model?: string | undefined
      readonly scope?: "shared" | "model" | undefined
      readonly nowMs?: number | undefined
    }
  ) => Effect.Effect<QuotaEntry, PlatformError | AccountsLocked>
  /** Clears every block for a label, including expired rows. */
  readonly clear: (label: string) => Effect.Effect<boolean, PlatformError | AccountsLocked>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 1.0.0
 */
export class QuotaStore extends Context.Service<QuotaStore, Service>()(
  "@smthrs-plugins/usage/QuotaStore"
) {}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : undefined

const parseState = (raw: string, nowMs: number): QuotaState => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { version: 1, entries: {} }
  }
  const root = asRecord(parsed)
  const rows = asRecord(root?.["entries"])
  if (root?.["version"] !== 1 || rows === undefined) return { version: 1, entries: {} }
  const entries: Record<string, QuotaEntry> = {}
  for (const [label, value] of Object.entries(rows)) {
    const entry = asRecord(value)
    if (entry === undefined) continue
    const untilMs = entry["untilMs"]
    if (typeof untilMs !== "number" || !Number.isFinite(untilMs) || untilMs <= nowMs) continue
    const model = entry["model"]
    const observedAt = entry["observedAt"]
    entries[label] = {
      untilMs,
      ...(typeof model === "string" ? { model } : {}),
      observedAt: typeof observedAt === "string" ? observedAt : new Date(nowMs).toISOString()
    }
  }
  return { version: 1, entries }
}

/**
 * Constructs the quota store over a file system and a Smithers root.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (fs: FileSystem.FileSystem, path: Path.Path, root: string): Service => {
  const file = path.join(root, "account-quota-state.json")
  const accountsFile = path.join(root, "accounts.json")

  const read: Service["read"] = (nowMs = Date.now()) =>
    Effect.gen(function*() {
      const exists = yield* fs.exists(file)
      if (!exists) return { version: 1, entries: {} } as QuotaState
      const raw = yield* Effect.result(fs.readFileString(file))
      return raw._tag === "Failure" ? { version: 1, entries: {} } as QuotaState : parseState(raw.success, nowMs)
    })

  const write = (state: QuotaState): Effect.Effect<void, PlatformError> =>
    Effect.gen(function*() {
      yield* fs.makeDirectory(root, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      yield* fs.rename(temporary, file)
    })

  return QuotaStore.of({
    path: Effect.succeed(file),
    read,
    record: (label, options = {}) =>
      // The registry lock, not a second one: `record` and an `accounts add`
      // rewrite two files under one Smithers root, and interleaving them is
      // what loses an entry.
      AccountsLock.withLock(
        fs,
        accountsFile,
        Effect.gen(function*() {
          const nowMs = options.nowMs ?? Date.now()
          const requested = typeof options.untilMs === "number" && Number.isFinite(options.untilMs) &&
              options.untilMs > nowMs
            ? options.untilMs
            : nowMs + unknownQuotaTtlMillis
          const state = yield* read(nowMs)
          const family = modelFamily(options.model)
          const key = options.scope === "model" && family !== "shared" ? `${label}::${family}` : label
          const entry: QuotaEntry = {
            untilMs: Math.max(requested, state.entries[key]?.untilMs ?? 0),
            ...(options.model === undefined ? {} : { model: options.model }),
            observedAt: new Date(nowMs).toISOString()
          }
          yield* write({ version: 1, entries: { ...state.entries, [key]: entry } })
          return entry
        })
      ),
    clear: (label) =>
      AccountsLock.withLock(
        fs,
        accountsFile,
        Effect.gen(function*() {
          // Read every syntactically valid row, expired ones included: an
          // explicit clear is cleanup and must remove stale rows too.
          const state = yield* read(0)
          const keys = Object.keys(state.entries).filter((key) =>
            key === label || key.startsWith(`${label}::`)
          )
          if (keys.length === 0) return false
          const entries = Object.fromEntries(
            Object.entries(state.entries).filter(([key]) => !keys.includes(key))
          )
          yield* write({ version: 1, entries })
          return true
        })
      )
  })
}

/**
 * The Smithers root the quota file lives under.
 *
 * @category services
 * @since 1.0.0
 */
export class UsageRoot extends Context.Service<UsageRoot, { readonly root: string }>()(
  "@smthrs-plugins/usage/UsageRoot"
) {}

/**
 * Provides {@link UsageRoot} from an explicit path.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerRoot = (root: string): Layer.Layer<UsageRoot> =>
  Layer.succeed(UsageRoot)(UsageRoot.of({ root }))

/**
 * Provides the quota store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<QuotaStore, never, FileSystem.FileSystem | Path.Path | UsageRoot> = Layer
  .effect(
    QuotaStore,
    Effect.gen(function*() {
      return make(yield* FileSystem.FileSystem, yield* Path.Path, (yield* UsageRoot).root)
    })
  )

/**
 * A quota store that records nothing, for a composition with no Smithers home.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  QuotaStore.of({
    path: Effect.succeed(""),
    read: () => Effect.succeed({ version: 1, entries: {} }),
    record: (_label, options = {}) =>
      Effect.succeed({
        untilMs: (options.nowMs ?? Date.now()) + unknownQuotaTtlMillis,
        observedAt: new Date(options.nowMs ?? Date.now()).toISOString()
      }),
    clear: () => Effect.succeed(false),
    ...overrides
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<QuotaStore> =>
  Layer.succeed(QuotaStore)(makeNoop(overrides))
