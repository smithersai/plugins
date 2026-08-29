/**
 * Where each vendor keeps the credential a subscription seat runs on.
 *
 * Nothing here returns a token to be logged, journaled, or persisted: a read
 * exists to mint one outbound header. Every read is an Effect over the kernel
 * file system, so a test binds a directory instead of a home.
 *
 * The rule worth naming is Claude Code's Keychain fallback. Claude keys a
 * per-configuration-dir login as `Claude Code-credentials-<first 8 hex of
 * sha256(configDir)>`. An account *with* a configuration directory never falls
 * back to the unsuffixed item, because that item belongs to the default
 * `~/.claude` login and using it would attribute one account's usage — and one
 * account's quota — to another.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { createHash } from "node:crypto"

/**
 * A subscription access token and what the vendor said about it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Credential {
  readonly accessToken: string
  /** Epoch milliseconds, when the vendor reported an expiry. */
  readonly expiresAt?: number | undefined
  /** The vendor's plan label, for example `max`. */
  readonly subscriptionType?: string | undefined
  /** The vendor's account identity, when it carries one. */
  readonly accountId?: string | undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringAt = (source: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = source[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

const numberAt = (source: Readonly<Record<string, unknown>>, name: string): number | undefined => {
  const value = source[name]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const readJson = (
  fs: FileSystem.FileSystem,
  path: string
): Effect.Effect<Readonly<Record<string, unknown>> | undefined> =>
  Effect.map(
    Effect.result(fs.readFileString(path)),
    (result) => {
      if (result._tag === "Failure") return undefined
      try {
        const parsed = JSON.parse(result.success) as unknown
        return isRecord(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }
  )

/**
 * The Keychain item suffix Claude Code derives from a configuration directory.
 *
 * @category conversions
 * @since 1.0.0
 */
export const claudeKeychainSuffix = (configDir: string): string =>
  createHash("sha256").update(configDir).digest("hex").slice(0, 8)

/**
 * The Keychain service names that may hold an account's Claude credential, in
 * the order they should be tried.
 *
 * An account with its own configuration directory yields exactly one name. The
 * unsuffixed item is offered only for the default install, because reading it
 * for an isolated account would mint a header for somebody else's
 * subscription.
 *
 * @category getters
 * @since 1.0.0
 */
export const claudeKeychainServices = (
  configDir: string | undefined,
  defaultConfigDir: string
): ReadonlyArray<string> => {
  if (configDir === undefined || configDir === defaultConfigDir) return ["Claude Code-credentials"]
  return [`Claude Code-credentials-${claudeKeychainSuffix(configDir)}`]
}

/**
 * Parses a Claude Code credentials document.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parseClaude = (value: unknown): Credential | undefined => {
  if (!isRecord(value)) return undefined
  const oauth = isRecord(value["claudeAiOauth"]) ? value["claudeAiOauth"] : undefined
  if (oauth === undefined) return undefined
  const accessToken = stringAt(oauth, "accessToken")
  if (accessToken === undefined) return undefined
  const expiresAt = numberAt(oauth, "expiresAt")
  const subscriptionType = stringAt(oauth, "subscriptionType")
  return {
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(subscriptionType === undefined ? {} : { subscriptionType })
  }
}

/**
 * Reads the Claude Code credential from an account's configuration directory.
 *
 * Answers `undefined` rather than failing, so a missing credential degrades to
 * a usage report with no numbers instead of a failed run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const claude = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configDir: string
): Effect.Effect<Credential | undefined> =>
  Effect.map(readJson(fs, path.join(configDir, ".credentials.json")), parseClaude)

/**
 * The claims inside a JWT, without verifying it.
 *
 * Reading a claim is not trusting it: the vendor's own account id is what the
 * caller needs, and the token was already accepted by the vendor that issued
 * it.
 *
 * @category conversions
 * @since 1.0.0
 */
export const decodeJwtClaims = (token: string): Readonly<Record<string, unknown>> | undefined => {
  const parts = token.split(".")
  if (parts.length < 2 || parts[1] === undefined) return undefined
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const decoded = Buffer.from(padded, "base64").toString("utf8")
    const parsed = JSON.parse(decoded) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Parses a Codex `auth.json`.
 *
 * The ChatGPT account id comes from `tokens.account_id`, or failing that from
 * the `chatgpt_account_id` claim in the id token.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parseCodex = (value: unknown): Credential | undefined => {
  if (!isRecord(value)) return undefined
  const tokens = isRecord(value["tokens"]) ? value["tokens"] : undefined
  if (tokens === undefined) return undefined
  const accessToken = stringAt(tokens, "access_token")
  if (accessToken === undefined) return undefined
  const idToken = stringAt(tokens, "id_token")
  const claims = idToken === undefined ? undefined : decodeJwtClaims(idToken)
  const accountId = stringAt(tokens, "account_id") ??
    (claims === undefined ? undefined : stringAt(claims, "chatgpt_account_id"))
  return { accessToken, ...(accountId === undefined ? {} : { accountId }) }
}

/**
 * Reads the Codex credential from an account's `CODEX_HOME`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const codex = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configDir: string
): Effect.Effect<Credential | undefined> =>
  Effect.map(readJson(fs, path.join(configDir, "auth.json")), parseCodex)

/**
 * Parses a Kimi credential document.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parseKimi = (value: unknown): Credential | undefined => {
  if (!isRecord(value)) return undefined
  const source = isRecord(value["auth"]) ? value["auth"] : value
  const accessToken = stringAt(source, "access_token") ?? stringAt(source, "accessToken")
  if (accessToken === undefined) return undefined
  const expiresAt = numberAt(source, "expires_at") ?? numberAt(source, "expiresAt")
  return { accessToken, ...(expiresAt === undefined ? {} : { expiresAt }) }
}

/**
 * Reads the Kimi credential from an account's `KIMI_SHARE_DIR`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const kimi = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configDir: string
): Effect.Effect<Credential | undefined> =>
  Effect.map(readJson(fs, path.join(configDir, "auth.json")), parseKimi)

/**
 * Whether a credential needs refreshing before it is used.
 *
 * The skew is deliberate: a token that expires while a request is in flight
 * fails the run, and refreshing a minute early costs nothing.
 *
 * @category predicates
 * @since 1.0.0
 */
export const expired = (
  credential: Credential,
  nowMs: number = Date.now(),
  skewMs = 60_000
): boolean => credential.expiresAt !== undefined && credential.expiresAt - skewMs <= nowMs
