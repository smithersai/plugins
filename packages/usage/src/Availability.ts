/**
 * The traffic light a seat pool reads before it picks an account.
 *
 * The distinction that matters is account-wide against model-scoped: an
 * exhausted five-hour session blocks every request, while an exhausted
 * per-model weekly cap still leaves the other models usable. Collapsing the
 * two would idle a whole subscription over one model's limit.
 *
 * @since 1.0.0
 */
import type { UsageWindow } from "./UsageReport.ts"

/**
 * One account's availability and the windows that explain it.
 *
 * @category models
 * @since 1.0.0
 */
export interface AccountAvailability {
  /**
   * - `blocked` — an account-wide window is exhausted.
   * - `degraded` — only a model-scoped window is exhausted.
   * - `ok` — every reported window has headroom.
   * - `unknown` — there is nothing to judge.
   */
  readonly status: "ok" | "degraded" | "blocked" | "unknown"
  /** Labels of the exhausted windows, account-wide ones first. */
  readonly reasons: ReadonlyArray<string>
}

/**
 * The utilization of a window, accounting for a reset that already passed.
 *
 * A window past its reset has rolled over, so its recorded utilization
 * describes the previous period and reads as fresh.
 *
 * @category getters
 * @since 1.0.0
 */
export const effectiveUsedPercent = (
  window: UsageWindow,
  nowMs: number
): number | undefined => {
  if (typeof window.usedPercent !== "number") return undefined
  if (typeof window.resetsAt === "string") {
    const resetMs = Date.parse(window.resetsAt)
    if (Number.isFinite(resetMs) && resetMs <= nowMs) return 0
  }
  return window.usedPercent
}

/**
 * Classifies windows into an availability.
 *
 * Pure: pass `nowMs` for a deterministic answer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const classifyAccountAvailability = (
  windows: ReadonlyArray<UsageWindow>,
  nowMs: number = Date.now()
): AccountAvailability => {
  if (windows.length === 0) return { status: "unknown", reasons: [] }
  const blocked: Array<string> = []
  const degraded: Array<string> = []
  for (const window of windows) {
    const used = effectiveUsedPercent(window, nowMs)
    const exhausted = used !== undefined
      ? used >= 100
      : window.unit === "count" && window.remaining !== undefined && window.remaining <= 0
    if (!exhausted) continue
    ;(window.modelScope === undefined ? blocked : degraded).push(`${window.label} exhausted`)
  }
  if (blocked.length > 0) return { status: "blocked", reasons: [...blocked, ...degraded] }
  if (degraded.length > 0) return { status: "degraded", reasons: degraded }
  return { status: "ok", reasons: [] }
}
