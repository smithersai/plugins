/**
 * One registered account and the file that holds them.
 *
 * Exactly one of `configDir` and `apiKey` is set: a subscription account is a
 * directory the vendor CLI reads, and an API account is a key. The registry
 * enforces that at every write, because an entry with both is ambiguous about
 * which credential a run would actually use.
 *
 * @since 1.0.0
 */
import { Schema } from "effect"
import * as AccountProvider from "./AccountProvider.ts"

/**
 * A single registered account.
 *
 * @category models
 * @since 1.0.0
 */
export interface Account {
  /** Unique label, for example `claude-work`. */
  readonly label: string
  readonly provider: AccountProvider.AccountProvider
  /** Absolute path to the per-account CLI configuration directory. */
  readonly configDir?: string | undefined
  /** Raw API key, stored in the mode-0600 registry file. */
  readonly apiKey?: string | undefined
  /** Default model to bind when this account is selected. */
  readonly model?: string | undefined
  /** ISO timestamp of registration. */
  readonly addedAt?: string | undefined
}

/**
 * A row whose provider this build does not recognize.
 *
 * These are carried through every rewrite verbatim. A legacy row names a
 * directory that still holds credentials, and an unrelated `add` or `remove`
 * that dropped it would take those credentials with it.
 *
 * @category models
 * @since 1.0.0
 */
export type UnknownAccount = Readonly<Record<string, unknown>> & { readonly label?: unknown }

/**
 * The parsed registry file.
 *
 * @category models
 * @since 1.0.0
 */
export interface AccountsFile {
  readonly version: 1
  readonly accounts: ReadonlyArray<Account>
  /** Present only when the file on disk carries unrecognized rows. */
  readonly unknownAccounts?: ReadonlyArray<UnknownAccount> | undefined
}

/**
 * Constructs an account, dropping keys the caller left undefined.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (input: Account): Account => ({
  label: input.label,
  provider: input.provider,
  ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
  ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.addedAt === undefined ? {} : { addedAt: input.addedAt })
})

/**
 * The empty registry a fresh install starts from.
 *
 * @category constructors
 * @since 1.0.0
 */
export const emptyFile = (): AccountsFile => ({ version: 1, accounts: [] })

/**
 * The schema an account is decoded and encoded with when it crosses a wire.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AccountSchema = Schema.Struct({
  label: Schema.String,
  provider: AccountProvider.AccountProvider,
  configDir: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  addedAt: Schema.optional(Schema.String)
})
