/**
 * Pure classification of CLI termination output.
 *
 * Matching is data-driven so vendor adapters can provide their own additions.
 * The default set contains provider-neutral Smithers quota tokens and common
 * command-line authentication/configuration diagnostics.
 *
 * Precedence is fixed and intentional: quota, session loss, authentication,
 * configuration, benign-only stderr, then an unknown protocol failure for a
 * non-zero exit. A known semantic failure therefore cannot be hidden by a
 * later benign diagnostic line.
 *
 * @since 0.1.0
 */
import * as AdapterError from "./AdapterError.ts"
import { truncateTailKeep } from "./CliOutput.ts"

/** A regular-expression pattern set supplied to the pure classifier.
 * @category models
 * @since 0.1.0
 */
export interface Patterns {
  readonly quota: ReadonlyArray<RegExp>
  readonly quotaOnSuccess?: ReadonlyArray<RegExp> | undefined
  readonly sessionLost: ReadonlyArray<RegExp>
  readonly auth: ReadonlyArray<RegExp>
  readonly config: ReadonlyArray<RegExp>
  readonly benign: ReadonlyArray<RegExp>
}

/** Input to {@link classify}.
 * @category models
 * @since 0.1.0
 */
export interface ClassificationInput {
  readonly exitCode: number | null | undefined
  readonly stderr?: string | undefined
  readonly records?: ReadonlyArray<unknown> | undefined
  readonly patterns?: Patterns | undefined
  readonly now?: number | (() => number) | undefined
}

/** A declarative set of default patterns used by CLI adapters.
 * @category models
 * @since 0.1.0
 */
export const defaultPatterns: Patterns = {
  quota: [
    /\bhit\s+your\s+(usage|session|weekly|daily|monthly|rate)\s+limit\b/i,
    /\busage\s+limit\s+exceeded\b/i,
    /\bquota\s+exceeded\b/i,
    /\brate\s+limit\s+exceeded\b/i,
    /\byou(?:'ve| have)\s+reached\s+(?:your\s+)?(usage|rate|quota|session|weekly|daily|monthly)\s+(?:limit|exceeded|cap|ceiling)\b/i,
    /\b(usage|quota|rate|session|weekly|daily|monthly)\s+(?:cap|ceiling|limit)\s+(?:reached|exceeded|hit)\b/i,
    /\btoo\s+many\s+requests\b/i,
    /\b(?:429|rate[\s._-]?limit)\b[\s\S]{0,120}?try\s+again\b/i,
    /\bout\s+of\s+usage\s+credits\b/i,
    /\brun\s+\/usage-credits\b/i,
    /\bout_of_credits\b/i,
    /\busage_limit_reached\b/i,
    // Billing exhaustion is a quota condition, not a protocol fault. Without
    // these the provider wordings below fall through to ProtocolError, which
    // loses the suspended outcome and the reset timing and instead reads as an
    // opaque adapter bug — the failure mode that cost a real run hours.
    /\bcredit\s+balance\s+is\s+too\s+low\b/i,
    /\binsufficient[_\s-]?quota\b/i,
    /\binsufficient\s+credits?\b/i,
    /\bexceeded\s+your\s+current\s+quota\b/i,
    /"rate_limit_event"[\s\S]{0,300}?"status"\s*:\s*"rejected"/i,
    /\b(?:rate[_-]?limit|quota|usage[_-]?limit)[_\s-]*(?:exhausted|reached|exceeded|rejected)\b/i
  ],
  quotaOnSuccess: [
    /^You've hit your session limit\s+·\s+resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s+(?:\([^)]+\)|[A-Z]{2,5})\.?$/i,
    /^You're out of usage credits\. Run \/usage-credits to keep using .+$/i,
    /^Claude usage limit reached\. Your limit will reset at \d{1,2}(?::\d{2})?\s*(?:am|pm)\s+(?:\([^)]+\)|[A-Z]{2,5})\.?$/i,
    /"rate_limit_event"[\s\S]{0,300}?"status"\s*:\s*"rejected"/i,
    // A CLI which prints a billing failure and still exits 0 has done no work;
    // anchored so it cannot fire on an agent merely discussing its credits.
    /^Your credit balance is too low\b[\s\S]*$/i
  ],
  sessionLost: [
    /\b(?:unknown|invalid|missing|expired|stale)\s+(?:resume\s+)?session(?:\s+id)?\b/i,
    /\bsession\s+(?:id\s+)?(?:not found|does not exist|no longer exists|has expired|expired)\b/i,
    /\b(?:could not|cannot|can't|unable to)\s+(?:find|resume|load)\s+(?:the\s+)?session\b/i,
    /\bno such session\b/i,
    /\bresume(?:_session)?[_\s-]*(?:not[_\s-]*found|expired|invalid)\b/i
  ],
  auth: [
    /\b401\b[\s\S]{0,200}?\b(?:unauthorized|authentication|api[_\s-]?key)\b/i,
    /\b(?:unauthorized|authentication failed|auth failed)\b/i,
    /\bfailed to (?:authenticate|log ?in|sign ?in)\b/i,
    /\binvalid[_\s-]?(?:api[_\s-]?)?key\b/i,
    /\bapi\s*key\b[\s\S]{0,100}?\b(?:invalid|expired|revoked|missing)\b/i,
    /\b(?:login|log in|sign in)\s+required\b/i,
    /\b(?:access|auth(?:entication)?|oauth|bearer)\s+token\b[\s\S]{0,100}?\b(?:expired|invalid|revoked)\b/i,
    // Claude Code prints this when its stored OAuth grant has lapsed. The word
    // "session" here is the login, not a resume id.
    /\boauth\s+(?:session|credential|grant|login)s?\b[\s\S]{0,60}?\b(?:expired|invalid|revoked)\b/i,
    /\bnot logged in\b/i
  ],
  config: [
    /\b(?:unknown|unrecognized|unsupported|invalid)\s+(?:option|flag|argument|parameter)\b/i,
    /\b(?:bad|invalid)\s+(?:flag|option|argument)\b/i,
    /\bmissing\s+(?:required\s+)?(?:option|flag|argument|config(?:uration)?)\b/i,
    /\b(?:config|configuration)\s+(?:file\s+)?(?:not found|missing|invalid|unreadable)\b/i,
    /\bunknown\s+(?:model|subcommand)\b/i
  ],
  benign: [
    /^\s*(?:update available|a new version is available|update notice)\b[\s\S]*$/i,
    /^\s*(?:telemetry|usage analytics|anonymous analytics)\b[\s\S]*$/i,
    /^\s*(?:notice|info)\s*:\s*(?:telemetry|update|analytics)\b[\s\S]*$/i,
    /^\s*(?:checking for updates|checking for update)\b[\s\S]*$/i
  ]
}

/** Default patterns for the Claude Code adapter.
 * @category models
 * @since 0.1.0
 */
export const claudeCodePatterns: Patterns = defaultPatterns

/** Default patterns for the Codex adapter.
 * @category models
 * @since 0.1.0
 */
export const codexPatterns: Patterns = defaultPatterns

const escapeCharacter = String.fromCharCode(27)

const stripAnsi = (text: string): string => text.replace(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g"), "")

const sanitizeDiagnostic = (text: string): string =>
  text
    // The optional scheme prefix matters: without it the value group would
    // consume the literal `Bearer` and leave the credential behind it intact.
    .replace(
      /(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^"',\s}]+/gi,
      "$1<redacted>"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted>")

const matches = (text: string, patterns: ReadonlyArray<RegExp>): boolean =>
  patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })

const diagnosticText = (stderr: string, records: ReadonlyArray<unknown>): string => {
  const recordText = records.flatMap((record) => {
    try {
      return [JSON.stringify(record)]
    } catch {
      return []
    }
  }).join("\n")
  return sanitizeDiagnostic(stripAnsi([stderr, recordText].filter((part) => part.length > 0).join("\n")))
}

const isFailureRecord = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const record = value as Readonly<Record<string, unknown>>
  const type = typeof record.type === "string" ? record.type.toLowerCase() : ""
  const subtype = typeof record.subtype === "string" ? record.subtype.toLowerCase() : ""
  const status = typeof record.status === "string" ? record.status.toLowerCase() : ""
  const outcome = typeof record.outcome === "string" ? record.outcome.toLowerCase() : ""
  return record.is_error === true
    || type === "error"
    || type.endsWith(".failed")
    || subtype.startsWith("error")
    || status === "rejected"
    || (type === "closed" && outcome !== "resolved")
}

const parseClockZone = (zone: string): string => {
  const normalized = zone.trim().toUpperCase()
  const aliases: Readonly<Record<string, string>> = {
    ET: "America/New_York",
    EST: "America/New_York",
    EDT: "America/New_York",
    PT: "America/Los_Angeles",
    PST: "America/Los_Angeles",
    PDT: "America/Los_Angeles",
    CT: "America/Chicago",
    CST: "America/Chicago",
    CDT: "America/Chicago",
    MT: "America/Denver",
    MST: "America/Denver",
    MDT: "America/Denver",
    UTC: "UTC",
    GMT: "UTC"
  }
  return aliases[normalized] ?? zone.trim()
}

const wallClockParts = (time: number, timeZone: string): { readonly hour: number; readonly minute: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(time))
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0"),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? "0")
  }
}

const nextWallClock = (hour: number, minute: number, zone: string, now: number): number | undefined => {
  const timeZone = parseClockZone(zone)
  try {
    for (let offset = 60_000; offset <= 8 * 86_400_000; offset += 60_000) {
      const candidate = now + offset
      const parts = wallClockParts(candidate, timeZone)
      if (parts.hour === hour && parts.minute === minute) return candidate
    }
  } catch {
    return undefined
  }
  return undefined
}

const quotaDetails = (
  text: string,
  now: number
): { readonly resetAt?: number | undefined; readonly retryAfterSeconds?: number | undefined } => {
  let resetAt: number | undefined
  let retryAfterSeconds: number | undefined
  const retry = /(?:retry[ _-]*after|retry_after|reset[ _-]*after)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)?/i.exec(
    text
  )
  if (retry) {
    retryAfterSeconds = Number(retry[1])
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) resetAt = now + retryAfterSeconds * 1000
  }
  const jsonRetry = /["'](?:retry[_-]?after|retryAfter)["']\s*:\s*(\d+(?:\.\d+)?)/i.exec(text)
  if (jsonRetry && retryAfterSeconds === undefined) {
    retryAfterSeconds = Number(jsonRetry[1])
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) resetAt = now + retryAfterSeconds * 1000
  }
  const absolute =
    /(?:try\s+again|reset|resets)[^\n]{0,30}?\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?))/i
      .exec(text)
      ?? /try\s+again\s+at\s+([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(text)
  if (absolute) {
    const parsed = Date.parse((absolute[1] ?? "").replace(/(\d+)(st|nd|rd|th)\b/gi, "$1"))
    if (Number.isFinite(parsed) && parsed > now) resetAt = parsed
  }
  const zoned = /\breset(?:s)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\)|\b([A-Z]{2,5})\b)/i.exec(
    text
  )
  if (zoned) {
    const meridiem = (zoned[3] ?? "am").toLowerCase()
    const hour = Number(zoned[1] ?? "0") % 12 + (meridiem === "pm" ? 12 : 0)
    const minute = Number(zoned[2] ?? "0")
    const parsed = nextWallClock(hour, minute, zoned[4] ?? zoned[5] ?? "UTC", now)
    if (parsed !== undefined) resetAt = parsed
  }
  const unix = /["']?(?:reset[_-]?at|resetAt)["']?\s*[:=]\s*(\d{10,13})/i.exec(text)
  if (unix) {
    const numeric = Number(unix[1])
    resetAt = numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  return {
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  }
}

const inputOf = (
  inputOrExitCode: ClassificationInput | number | null,
  stderr: string,
  records: ReadonlyArray<unknown>,
  patterns: Patterns
): ClassificationInput =>
  typeof inputOrExitCode === "object" && inputOrExitCode !== null
    ? inputOrExitCode
    : { exitCode: inputOrExitCode, stderr, records, patterns }

/** Returns whether stderr consists only of an allowlisted benign notice.
 * @category predicates
 * @since 0.1.0
 */
export const isBenignStderr = (stderr: string, patterns: Patterns = defaultPatterns): boolean => {
  const lines = stripAnsi(stderr).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length === 0 || lines.every((line) => matches(line, patterns.benign))
}

/**
 * Classifies CLI termination output according to the documented precedence.
 * `undefined` is the benign/success result; non-zero unknown exits become a
 * ProtocolError so callers never silently lose a failed process.
 *
 * @category destructors
 * @since 0.1.0
 */
export function classify(input: ClassificationInput): AdapterError.AdapterError | undefined
export function classify(
  exitCode: number | null,
  stderr?: string,
  records?: ReadonlyArray<unknown>,
  patterns?: Patterns
): AdapterError.AdapterError | undefined
export function classify(
  inputOrExitCode: ClassificationInput | number | null,
  stderr = "",
  records: ReadonlyArray<unknown> = [],
  patterns: Patterns = defaultPatterns
): AdapterError.AdapterError | undefined {
  const input = inputOf(inputOrExitCode, stderr, records, patterns)
  const selectedPatterns = input.patterns ?? defaultPatterns
  const selectedRecords = input.records ?? []
  const text = diagnosticText(input.stderr ?? "", selectedRecords)
  const nowValue = typeof input.now === "function" ? input.now() : input.now ?? Date.now()

  const semanticFailure = selectedRecords.some(isFailureRecord)
  const quotaPatterns = input.exitCode === 0 && !semanticFailure
    ? selectedPatterns.quotaOnSuccess ?? []
    : selectedPatterns.quota
  if (matches(text, quotaPatterns)) {
    const details = quotaDetails(text, nowValue)
    return new AdapterError.QuotaExhausted({ message: truncateTailKeep(text, 4096), ...details })
  }
  if (input.exitCode === 0 && !semanticFailure) return undefined
  // Authentication outranks session loss. The two recoveries point in opposite
  // directions: a lost session is repaired by dropping the resume token and
  // retrying on the same seat, while a lapsed login is only repaired by moving
  // to another seat. Vendors describe a lapsed login in words that also name a
  // "session" ("OAuth session expired"), so reading session first would keep a
  // pool retrying a dead account. A message that names authentication is about
  // the seat; the session patterns below only fire on a resume id.
  if (matches(text, selectedPatterns.auth)) {
    return new AdapterError.AuthFailed({ message: truncateTailKeep(text, 4096) })
  }
  if (matches(text, selectedPatterns.sessionLost)) {
    return new AdapterError.SessionLost({ message: truncateTailKeep(text, 4096), discardResumeSession: true })
  }
  if (matches(text, selectedPatterns.config)) {
    return new AdapterError.ConfigInvalid({ message: truncateTailKeep(text, 4096) })
  }
  // Only an actual benign notice suppresses a failure. Empty stderr is not a
  // benign notice: a process which exits non-zero without saying anything, or
  // which reports its failure only in stdout records, must still surface as a
  // ProtocolError instead of being silently reported as a success.
  const stderrText = input.stderr ?? ""
  if (stderrText.trim().length > 0 && isBenignStderr(stderrText, selectedPatterns)) return undefined
  if (input.exitCode === null || input.exitCode === undefined || input.exitCode === 0) return undefined
  return new AdapterError.ProtocolError({
    message: text.trim().length === 0 ? `CLI exited with code ${input.exitCode}` : truncateTailKeep(text, 4096)
  })
}

/** Alias emphasizing that records and stderr are classified as one CLI result.
 * @category destructors
 * @since 0.1.0
 */
export const classifyCliOutput = classify

/** Alias used by adapter specs when classifying a process termination.
 * @category destructors
 * @since 0.1.0
 */
export const classifyTermination = classify
