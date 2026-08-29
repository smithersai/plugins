/**
 * Reading the on-disk registry without losing rows this build cannot parse.
 *
 * @since 1.0.0
 */
import { Result } from "effect"
import type { Account, AccountsFile, UnknownAccount } from "./Account.ts"
import * as AccountProvider from "./AccountProvider.ts"
import { AccountsFileInvalid } from "./AccountsError.ts"

const invalid = (message: string) => Result.fail(new AccountsFileInvalid({ message }))

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : undefined

/**
 * The unrecognized-provider rows skipped by the last {@link parse}.
 *
 * A caller that wants to warn about them reads this from the parse result
 * rather than from a module-level side effect, so a library consumer decides
 * whether a stale row is worth a message.
 *
 * @category models
 * @since 1.0.0
 */
export interface Parsed {
  readonly file: AccountsFile
  /** `label: provider` for each row that was preserved but not loaded. */
  readonly skipped: ReadonlyArray<string>
}

/**
 * Parses the registry file's text.
 *
 * A row whose provider this build does not recognize is preserved rather than
 * loaded: one stale entry must not lock an operator out of every valid
 * account. A row that is recognized but malformed still fails the parse,
 * because that is corruption of a live account.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parse = (raw: string): Result.Result<Parsed, AccountsFileInvalid> => {
  if (raw.trim() === "") return Result.succeed({ file: { version: 1, accounts: [] }, skipped: [] })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return invalid(`accounts.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const root = asRecord(parsed)
  if (root === undefined) return invalid("accounts.json must be a JSON object")
  if (root["version"] !== 1) {
    return invalid(`accounts.json: unsupported version ${JSON.stringify(root["version"])} (expected 1)`)
  }
  const rows = root["accounts"]
  if (!Array.isArray(rows)) return invalid("accounts.json: `accounts` must be an array")

  const seen = new Set<string>()
  const accounts: Array<Account> = []
  const unknownAccounts: Array<UnknownAccount> = []
  const skipped: Array<string> = []

  for (let index = 0; index < rows.length; index += 1) {
    const entry = asRecord(rows[index])
    if (entry === undefined) return invalid(`accounts.json: accounts[${index}] must be an object`)
    const label = entry["label"]
    if (typeof label !== "string" || label.trim() === "") {
      return invalid(`accounts.json: accounts[${index}].label must be a non-empty string`)
    }
    const provider = entry["provider"]
    if (!AccountProvider.isProvider(provider)) {
      unknownAccounts.push(entry as UnknownAccount)
      skipped.push(`${label}: ${String(provider)}`)
      continue
    }
    if (seen.has(label)) return invalid(`accounts.json: duplicate label ${JSON.stringify(label)}`)
    seen.add(label)
    const configDir = entry["configDir"]
    const apiKey = entry["apiKey"]
    if (typeof configDir === "string" && typeof apiKey === "string") {
      return invalid(`accounts.json: ${label} (${provider}) must set configDir or apiKey, never both`)
    }
    if (AccountProvider.isSubscription(provider) && (typeof configDir !== "string" || configDir.trim() === "")) {
      return invalid(`accounts.json: ${label} (${provider}) requires a non-empty configDir`)
    }
    if (AccountProvider.isApiKey(provider) && typeof apiKey !== "string") {
      return invalid(`accounts.json: ${label} (${provider}) requires apiKey (may be empty for env-var-only)`)
    }
    const model = entry["model"]
    const addedAt = entry["addedAt"]
    accounts.push({
      label,
      provider,
      ...(typeof configDir === "string" ? { configDir } : {}),
      ...(typeof apiKey === "string" ? { apiKey } : {}),
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof addedAt === "string" ? { addedAt } : {})
    })
  }

  return Result.succeed({
    file: unknownAccounts.length === 0 ? { version: 1, accounts } : { version: 1, accounts, unknownAccounts },
    skipped
  })
}

/**
 * Serializes a registry back to the exact on-disk shape.
 *
 * Unrecognized rows are appended to `accounts`; `unknownAccounts` is never a
 * key on disk, so a file this build wrote and a file it round-tripped are the
 * same bytes.
 *
 * @category constructors
 * @since 1.0.0
 */
export const serialize = (file: AccountsFile): string =>
  `${
    JSON.stringify(
      { version: file.version, accounts: [...file.accounts, ...(file.unknownAccounts ?? [])] },
      null,
      2
    )
  }\n`
