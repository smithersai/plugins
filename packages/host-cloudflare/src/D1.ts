/**
 * SQLite descriptors over Cloudflare storage.
 *
 * Two shapes, and the difference between them is the whole point of this
 * module. A Durable Object's storage has a real `transaction`, so its
 * descriptor reports whatever the object gave it. D1 has no interactive
 * transaction at all — its prepare/bind/run API cannot hold a `BEGIN` open
 * across round trips — so its descriptor reports `supportsTransactions: false`
 * and a transactional write fails before it begins rather than committing half
 * of itself.
 *
 * `database.batch()` is not a substitute: the transaction bodies Smithers
 * writes are interactive read-then-write, which a fixed batch array cannot
 * express.
 *
 * @since 1.0.0
 */

/**
 * The SQLite surface a Smithers database binding adapts.
 *
 * @category models
 * @since 1.0.0
 */
export interface SqliteDescriptor {
  readonly dialect: "sqlite"
  readonly driver: "cloudflare-sqlite"
  readonly queryAllRaw: (
    statement: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<Record<string, unknown>>> | ReadonlyArray<Record<string, unknown>>
  readonly queryValuesRaw: (
    statement: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<ReadonlyArray<unknown>>> | ReadonlyArray<ReadonlyArray<unknown>>
  readonly execute: (
    statement: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<never>> | ReadonlyArray<never>
  /** False means a transactional write is refused before it starts. */
  readonly supportsTransactions: boolean
  readonly transaction?: (<A>(body: () => A) => A) | undefined
}

/**
 * The SQL cursor a Durable Object's storage exposes.
 *
 * @category models
 * @since 1.0.0
 */
export interface SqlStorage {
  readonly exec: (
    statement: string,
    ...params: ReadonlyArray<unknown>
  ) => Iterable<Record<string, unknown>> & { readonly raw?: () => Iterable<ReadonlyArray<unknown>> }
}

/**
 * The D1 prepared-statement surface.
 *
 * @category models
 * @since 1.0.0
 */
export interface D1Database {
  readonly prepare: (statement: string) => {
    readonly bind: (...params: ReadonlyArray<unknown>) => {
      readonly all: () => Promise<{ readonly results?: ReadonlyArray<Record<string, unknown>> }>
      readonly raw?: (() => Promise<ReadonlyArray<ReadonlyArray<unknown>>>) | undefined
      readonly run: () => Promise<unknown>
    }
  }
}

/**
 * A descriptor over a Durable Object's SQLite storage.
 *
 * @category constructors
 * @since 1.0.0
 */
export const durableObjectDescriptor = (
  storage: SqlStorage & { readonly sql?: SqlStorage; readonly transaction?: <A>(body: () => A) => A }
): SqliteDescriptor => {
  const sql = storage.sql ?? storage
  const transaction = typeof storage.transaction === "function"
    ? storage.transaction.bind(storage)
    : undefined
  return {
    dialect: "sqlite",
    driver: "cloudflare-sqlite",
    queryAllRaw: (statement, params = []) => [...sql.exec(statement, ...params)],
    queryValuesRaw: (statement, params = []) => {
      const cursor = sql.exec(statement, ...params)
      return cursor.raw === undefined
        ? [...cursor].map((row) => Object.values(row))
        : [...cursor.raw()]
    },
    execute: (statement, params = []) => {
      for (const _ of sql.exec(statement, ...params)) { /* drain */ }
      return []
    },
    supportsTransactions: transaction !== undefined,
    ...(transaction === undefined ? {} : { transaction })
  }
}

/**
 * A descriptor over a D1 database.
 *
 * Reserve D1 for read-mostly work: `supportsTransactions` is false, so the
 * run-of-record flows refuse it before they start rather than leaving partial
 * durable state behind a crash.
 *
 * @category constructors
 * @since 1.0.0
 */
export const d1Descriptor = (database: D1Database): SqliteDescriptor => ({
  dialect: "sqlite",
  driver: "cloudflare-sqlite",
  queryAllRaw: async (statement, params = []) => {
    const result = await database.prepare(statement).bind(...params).all()
    return result.results ?? []
  },
  queryValuesRaw: async (statement, params = []) => {
    const prepared = database.prepare(statement).bind(...params)
    if (prepared.raw !== undefined) return prepared.raw()
    const result = await prepared.all()
    return (result.results ?? []).map((row) => Object.values(row))
  },
  execute: async (statement, params = []) => {
    await database.prepare(statement).bind(...params).run()
    return []
  },
  // Never a pass-through callback: one would claim atomicity D1 cannot give
  // and can leave partial durable state behind a mid-write failure.
  supportsTransactions: false
})
