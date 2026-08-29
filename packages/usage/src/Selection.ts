/**
 * Ordering registered accounts by how much headroom each one has.
 *
 * The pool asks one question — which account should the next run use — and the
 * answer combines two sources: what a provider told us when it refused
 * (`QuotaState`) and what the last usage probe measured (`UsageReport`). An
 * account a provider has blocked sorts last regardless of its measured usage,
 * because its measurement is stale by definition.
 *
 * Pure. Every function takes the state it reads, so a test pins an ordering
 * without a home directory or a clock.
 *
 * @since 1.0.0
 */
import type { Account } from "@smthrs-plugins/accounts/Account"
import { modelFamily } from "./ModelFamily.ts"
import type { QuotaEntry, QuotaState } from "./QuotaState.ts"
import { unknownQuotaTtlMillis } from "./QuotaState.ts"
import type { UsageReport } from "./UsageReport.ts"

/**
 * The score of an account with no usable report: worse than any real one, so a
 * probe failure never wins a tie against a measured account.
 *
 * @category constants
 * @since 1.0.0
 */
export const unknownScore = 101

const exhaustedUsageBlock = (
  report: UsageReport | undefined,
  model: string | undefined,
  nowMs: number
): QuotaEntry | undefined => {
  if (report === undefined || report.source === "none") return undefined
  const family = modelFamily(model)
  const relevant = new Set(["5h", "weekly"])
  if (family !== "shared") relevant.add(`weekly-${family}`)
  const exhausted = report.windows.filter((window) => {
    if (!relevant.has(window.id)) return false
    let usedPercent = window.usedPercent
    // Older payloads omit the dedicated Fable window. Fable draws on half the
    // weekly plan, so shared weekly consumption normalizes against that cap.
    if (
      family === "fable" && window.id === "weekly" &&
      !report.windows.some((row) => row.id === "weekly-fable")
    ) {
      usedPercent = typeof usedPercent === "number" ? usedPercent * 2 : usedPercent
    }
    return typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= 100
  })
  if (exhausted.length === 0) return undefined
  const resets = exhausted.flatMap((window) => {
    const resetMs = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN
    if (Number.isFinite(resetMs)) return resetMs > nowMs ? [resetMs] : []
    return [nowMs + unknownQuotaTtlMillis]
  })
  if (resets.length === 0) return undefined
  return {
    untilMs: Math.max(...resets),
    ...(model === undefined ? {} : { model }),
    observedAt: report.fetchedAt
  }
}

/**
 * The quota block that applies to one account and model, if any.
 *
 * A shared block applies to every model; a family block applies only to its
 * own. When both apply the account is usable only after the later reset.
 *
 * @category getters
 * @since 1.0.0
 */
export const accountQuotaBlock = (
  entries: QuotaState["entries"],
  label: string,
  model: string | undefined,
  report?: UsageReport | undefined,
  nowMs: number = Date.now()
): QuotaEntry | undefined => {
  const family = modelFamily(model)
  const blocks = [
    entries[label],
    ...(family === "shared" ? [] : [entries[`${label}::${family}`]]),
    exhaustedUsageBlock(report, model, nowMs)
  ].filter((entry): entry is QuotaEntry => entry !== undefined)
  return blocks.sort((left, right) => right.untilMs - left.untilMs)[0]
}

/**
 * How used an account is for a model, from 0 (fresh) to
 * {@link unknownScore} (unmeasured). Lower is better.
 *
 * @category getters
 * @since 1.0.0
 */
export const accountUsageScore = (
  report: UsageReport | undefined,
  model: string | undefined
): number => {
  if (report === undefined || report.source === "none") return unknownScore
  const family = modelFamily(model)
  const ids = new Set(["5h", "weekly"])
  if (family !== "shared") ids.add(`weekly-${family}`)
  const matching = report.windows.filter((window) => ids.has(window.id))
  const values = matching
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  if (family === "fable" && !matching.some((window) => window.id === "weekly-fable")) {
    const weekly = report.windows.find((window) => window.id === "weekly")?.usedPercent
    if (typeof weekly === "number" && Number.isFinite(weekly)) values.push(Math.min(100, weekly * 2))
  }
  return values.length > 0 ? Math.max(...values) : 100
}

/**
 * Orders accounts from most headroom to least.
 *
 * Blocked accounts sort last with the soonest reset first, so a caller that
 * must pick one still picks the one that recovers first.
 *
 * @category constructors
 * @since 1.0.0
 */
export const orderAccountsByUsage = (
  accounts: ReadonlyArray<Account>,
  options: {
    readonly quota: QuotaState["entries"]
    readonly reports?: Readonly<Record<string, UsageReport>> | undefined
    readonly modelFor?: ((account: Account) => string | undefined) | undefined
    readonly nowMs?: number | undefined
    readonly tieBreak?: ReadonlyMap<string, number> | undefined
  }
): ReadonlyArray<Account> => {
  const nowMs = options.nowMs ?? Date.now()
  const reports = options.reports ?? {}
  const modelFor = options.modelFor ?? ((account: Account) => account.model)
  return [...accounts].sort((left, right) => {
    const leftBlock = accountQuotaBlock(options.quota, left.label, modelFor(left), reports[left.label], nowMs)
    const rightBlock = accountQuotaBlock(options.quota, right.label, modelFor(right), reports[right.label], nowMs)
    if ((leftBlock !== undefined) !== (rightBlock !== undefined)) return leftBlock !== undefined ? 1 : -1
    if (leftBlock !== undefined && rightBlock !== undefined && leftBlock.untilMs !== rightBlock.untilMs) {
      return leftBlock.untilMs - rightBlock.untilMs
    }
    const score = accountUsageScore(reports[left.label], modelFor(left)) -
      accountUsageScore(reports[right.label], modelFor(right))
    if (score !== 0) return score
    const tie = (options.tieBreak?.get(left.label) ?? 0) - (options.tieBreak?.get(right.label) ?? 0)
    return tie !== 0 ? tie : left.label.localeCompare(right.label)
  })
}
