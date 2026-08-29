/**
 * The account registry, as an Effect service over the kernel file system.
 *
 * Everything that touches disk is one method on this service, so a test binds
 * a memory file system and a run binds the kernel's permission-checked one.
 * Nothing here reaches for `node:fs`, and nothing here reads `process.env`
 * except through the {@link Config} the caller supplies, which is what makes
 * the registry testable without a home directory.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer, Result } from "effect"
import * as FileSystem from "effect/FileSystem"
import type { PlatformError } from "effect/PlatformError"
import * as Path from "effect/Path"
import type { Account, AccountsFile, UnknownAccount } from "./Account.ts"
import * as AccountProvider from "./AccountProvider.ts"
import {
  AccountDuplicateLabel,
  AccountInvalid,
  AccountNotFound,
  type AccountsError,
  AccountsFileInvalid
} from "./AccountsError.ts"
import * as AccountsLock from "./AccountsLock.ts"
import { parse, serialize } from "./parse.ts"

/**
 * Where the registry lives.
 *
 * `root` is the Smithers home directory. `SMITHERS_HOME` overrides it, which
 * is how a test and a CI job get their own registry without touching the
 * operator's.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
  readonly root: string
}

/**
 * The {@link Config} tag.
 *
 * @category services
 * @since 1.0.0
 */
export class AccountsConfig extends Context.Service<AccountsConfig, Config>()(
  "@smthrs-plugins/accounts/AccountsConfig"
) {}

/**
 * Resolves the registry root from an environment, honoring `SMITHERS_HOME`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rootFrom = (
  path: Path.Path,
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string => {
  const override = env["SMITHERS_HOME"]
  if (override !== undefined && override !== "") return override
  return path.join(env["HOME"] ?? home, ".smithers")
}

/**
 * The registry's operations.
 *
 * @category services
 * @since 1.0.0
 */
export interface Service {
  /** The absolute path of the registry file. */
  readonly path: Effect.Effect<string>
  /** Reads the registry, answering an empty one when the file is absent. */
  readonly read: Effect.Effect<AccountsFile, AccountsError | PlatformError>
  /** Registered accounts, in registration order. */
  readonly list: Effect.Effect<ReadonlyArray<Account>, AccountsError | PlatformError>
  /** One account by label, or `AccountNotFound`. */
  readonly get: (label: string) => Effect.Effect<Account, AccountsError | PlatformError>
  /** Adds an account, or replaces the same-label one when `replace` is set. */
  readonly add: (
    account: Account,
    options?: { readonly replace?: boolean | undefined; readonly now?: string | undefined }
  ) => Effect.Effect<Account, AccountsError | PlatformError>
  /** Removes an account by label, including a preserved unrecognized row. */
  readonly remove: (
    label: string,
    options?: { readonly silent?: boolean | undefined }
  ) => Effect.Effect<boolean, AccountsError | PlatformError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 1.0.0
 */
export class Accounts extends Context.Service<Accounts, Service>()("@smthrs-plugins/accounts/Accounts") {}

const validate = (account: Account): Result.Result<void, AccountInvalid> => {
  if (account.label.trim() === "") {
    return Result.fail(new AccountInvalid({ message: "account.label must be a non-empty string" }))
  }
  if (!AccountProvider.isProvider(account.provider)) {
    return Result.fail(
      new AccountInvalid({
        message: `account.provider must be one of ${
          AccountProvider.names().join(", ")
        }, got ${JSON.stringify(account.provider)}`
      })
    )
  }
  if (typeof account.configDir === "string" && typeof account.apiKey === "string") {
    return Result.fail(
      new AccountInvalid({
        message: `${account.provider} account "${account.label}" must set configDir or apiKey, never both`
      })
    )
  }
  if (
    AccountProvider.isSubscription(account.provider) &&
    (account.configDir === undefined || account.configDir.trim() === "")
  ) {
    return Result.fail(
      new AccountInvalid({ message: `${account.provider} accounts require a non-empty configDir` })
    )
  }
  if (AccountProvider.isApiKey(account.provider) && typeof account.apiKey !== "string") {
    return Result.fail(
      new AccountInvalid({
        message: `${account.provider} accounts require apiKey (may be empty for env-var-only)`
      })
    )
  }
  return Result.succeed(undefined)
}

const labelOf = (row: UnknownAccount): string | undefined =>
  typeof row["label"] === "string" ? row["label"] : undefined

/**
 * Constructs the registry over a file system, a path service, and a root.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: Config
): Service => {
  const file = path.join(config.root, "accounts.json")

  const read: Service["read"] = Effect.gen(function*() {
    const exists = yield* fs.exists(file)
    if (!exists) return { version: 1, accounts: [] } as AccountsFile
    const raw = yield* fs.readFileString(file)
    const parsed = yield* Effect.fromResult(parse(raw))
    return parsed.file
  })

  const write = (contents: AccountsFile): Effect.Effect<void, PlatformError> =>
    Effect.gen(function*() {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      // pid, time, and randomness so two same-millisecond writers never share
      // a temporary path and clobber each other's in-flight bytes.
      const temporary = `${file}.tmp.${process.pid}.${Date.now()}.${
        Math.random().toString(16).slice(2, 14)
      }`
      yield* fs.writeFileString(temporary, serialize(contents), { mode: 0o600 })
      const renamed = yield* Effect.result(fs.rename(temporary, file))
      if (renamed._tag === "Failure") {
        // Never leave a plaintext-key temporary file behind.
        yield* Effect.ignore(fs.remove(temporary, { force: true }))
        return yield* Effect.fail(renamed.failure)
      }
      yield* fs.chmod(file, 0o600)
    })

  const modify = <A>(
    critical: (current: AccountsFile) => Effect.Effect<readonly [AccountsFile | undefined, A], AccountsError>
  ): Effect.Effect<A, AccountsError | PlatformError> =>
    AccountsLock.withLock(
      fs,
      file,
      Effect.gen(function*() {
        const current = yield* read
        const [next, answer] = yield* critical(current)
        if (next !== undefined) yield* write(next)
        return answer
      })
    )

  return Accounts.of({
    path: Effect.succeed(file),
    read,
    list: Effect.map(read, (contents) => contents.accounts),
    get: (label) =>
      Effect.flatMap(read, (contents) => {
        const found = contents.accounts.find((entry) => entry.label === label)
        return found === undefined
          ? Effect.fail(
            new AccountNotFound({ label, message: `No account with label "${label}" is registered.` })
          )
          : Effect.succeed(found)
      }),
    add: (account, options = {}) =>
      Effect.flatMap(
        Effect.fromResult(validate(account)),
        () =>
          modify((current) => {
            const preserved = current.unknownAccounts ?? []
            const conflict = current.accounts.findIndex((entry) => entry.label === account.label)
            const preservedConflict = preserved.findIndex((entry) => labelOf(entry) === account.label)
            if ((conflict >= 0 || preservedConflict >= 0) && options.replace !== true) {
              return Effect.fail(
                new AccountDuplicateLabel({
                  label: account.label,
                  message:
                    `An account with label "${account.label}" already exists. Pass replace to overwrite, or use a different label.`
                })
              )
            }
            const persisted: Account = {
              label: account.label,
              provider: account.provider,
              ...(account.configDir === undefined || account.configDir === ""
                ? {}
                : { configDir: account.configDir }),
              ...(account.apiKey === undefined ? {} : { apiKey: account.apiKey }),
              ...(account.model === undefined || account.model === "" ? {} : { model: account.model }),
              addedAt: account.addedAt ?? current.accounts[conflict]?.addedAt ?? options.now ??
                new Date().toISOString()
            }
            const accounts = conflict >= 0
              ? current.accounts.map((entry, index) => index === conflict ? persisted : entry)
              : [...current.accounts, persisted]
            // `replace` on a legacy label supersedes it: that is the migration
            // path off an unrecognized provider.
            const unknownAccounts = preserved.filter((entry) => labelOf(entry) !== account.label)
            return Effect.succeed(
              [
                unknownAccounts.length === 0
                  ? { version: 1, accounts } as AccountsFile
                  : { version: 1, accounts, unknownAccounts } as AccountsFile,
                persisted
              ] as const
            )
          })
      ),
    remove: (label, options = {}) =>
      modify((current) => {
        const preserved = current.unknownAccounts ?? []
        const accounts = current.accounts.filter((entry) => entry.label !== label)
        const unknownAccounts = preserved.filter((entry) => labelOf(entry) !== label)
        const removed = accounts.length !== current.accounts.length ||
          unknownAccounts.length !== preserved.length
        if (!removed) {
          return options.silent === true
            ? Effect.succeed([undefined, false] as const)
            : Effect.fail(
              new AccountNotFound({ label, message: `No account with label "${label}" is registered.` })
            )
        }
        return Effect.succeed(
          [
            unknownAccounts.length === 0
              ? { version: 1, accounts } as AccountsFile
              : { version: 1, accounts, unknownAccounts } as AccountsFile,
            true
          ] as const
        )
      })
  })
}

/**
 * Provides the registry from a configured root.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Accounts, never, FileSystem.FileSystem | Path.Path | AccountsConfig> = Layer
  .effect(
    Accounts,
    Effect.gen(function*() {
      return make(yield* FileSystem.FileSystem, yield* Path.Path, yield* AccountsConfig)
    })
  )

/**
 * Provides {@link AccountsConfig} from an explicit root.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerConfig = (root: string): Layer.Layer<AccountsConfig> =>
  Layer.succeed(AccountsConfig)(AccountsConfig.of({ root }))

/**
 * Provides {@link AccountsConfig} from an environment, honoring
 * `SMITHERS_HOME`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): Layer.Layer<AccountsConfig, never, Path.Path> =>
  Layer.effect(
    AccountsConfig,
    Effect.map(Path.Path, (path) => AccountsConfig.of({ root: rootFrom(path, env, home) }))
  )

/**
 * A registry that answers nothing, so an unconfigured composition refuses
 * rather than inventing a home directory.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  Accounts.of({
    path: Effect.succeed(""),
    read: Effect.succeed({ version: 1, accounts: [] }),
    list: Effect.succeed([]),
    get: (label) =>
      Effect.fail(new AccountNotFound({ label, message: "No account registry is configured" })),
    add: () => Effect.fail(new AccountsFileInvalid({ message: "No account registry is configured" })),
    remove: () => Effect.succeed(false),
    ...overrides
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Accounts> =>
  Layer.succeed(Accounts)(makeNoop(overrides))
