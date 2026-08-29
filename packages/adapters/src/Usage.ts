/**
 * Token accounting, normalized across vendors.
 *
 * Every CLI reports the same four numbers under different names — snake case,
 * camel case, nested under `usage`, split into cache reads and cache writes —
 * and a caller that priced a run against one vendor's spelling would silently
 * read zero from another. This module is that translation, once.
 *
 * @since 1.0.0
 */

/**
 * Normalized token counts for one turn.
 *
 * Every field is optional because a vendor that does not report a number must
 * not be made to look like one that reported zero.
 *
 * @category models
 * @since 1.0.0
 */
export interface NormalizedTokenUsage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
  readonly cachedInputTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly totalTokens?: number | undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const numberAt = (
  source: Readonly<Record<string, unknown>>,
  ...names: ReadonlyArray<string>
): number | undefined => {
  for (const name of names) {
    const value = source[name]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

const sum = (...values: ReadonlyArray<number | undefined>): number | undefined => {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0)
}

const compact = (usage: NormalizedTokenUsage): NormalizedTokenUsage =>
  Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined)
  ) as NormalizedTokenUsage

/**
 * Normalizes any vendor's usage object.
 *
 * @category conversions
 * @since 1.0.0
 */
export const normalize = (value: unknown): NormalizedTokenUsage => {
  if (!isRecord(value)) return {}
  const source = isRecord(value["usage"]) ? value["usage"] : value
  const details = isRecord(source["completion_tokens_details"]) ? source["completion_tokens_details"] : {}
  const promptDetails = isRecord(source["prompt_tokens_details"]) ? source["prompt_tokens_details"] : {}
  return compact({
    inputTokens: numberAt(source, "inputTokens", "input_tokens", "prompt_tokens"),
    outputTokens: numberAt(source, "outputTokens", "output_tokens", "completion_tokens"),
    reasoningTokens: numberAt(source, "reasoningTokens", "reasoning_tokens") ??
      numberAt(details, "reasoning_tokens"),
    cachedInputTokens: numberAt(
      source,
      "cachedInputTokens",
      "cached_input_tokens",
      "cache_read_input_tokens"
    ) ?? numberAt(promptDetails, "cached_tokens"),
    cacheWriteTokens: numberAt(source, "cacheWriteTokens", "cache_creation_input_tokens"),
    totalTokens: numberAt(source, "totalTokens", "total_tokens")
  })
}

/**
 * DeepSeek reports its cache split as hit and miss rather than read and write,
 * and its `prompt_cache_hit_tokens` is a *subset* of `prompt_tokens` rather
 * than an addition to it. Reading it as an addition double-counts every cached
 * prompt.
 *
 * @category conversions
 * @since 1.0.0
 */
export const deepseek = (value: unknown): NormalizedTokenUsage => {
  if (!isRecord(value)) return {}
  const source = isRecord(value["usage"]) ? value["usage"] : value
  const hit = numberAt(source, "prompt_cache_hit_tokens")
  const prompt = numberAt(source, "prompt_tokens")
  return compact({
    ...(prompt === undefined ? {} : { inputTokens: prompt }),
    outputTokens: numberAt(source, "completion_tokens"),
    ...(hit === undefined ? {} : { cachedInputTokens: hit }),
    totalTokens: numberAt(source, "total_tokens")
  })
}

/**
 * Kimi's wire usage arrives on the stream's final chunk, with the cached count
 * nested one level deeper than the rest.
 *
 * @category conversions
 * @since 1.0.0
 */
export const kimiWire = (value: unknown): NormalizedTokenUsage => {
  if (!isRecord(value)) return {}
  const source = isRecord(value["usage"]) ? value["usage"] : value
  const cached = isRecord(source["prompt_tokens_details"])
    ? numberAt(source["prompt_tokens_details"], "cached_tokens")
    : undefined
  const input = numberAt(source, "prompt_tokens", "input_tokens")
  const output = numberAt(source, "completion_tokens", "output_tokens")
  return compact({
    inputTokens: input,
    outputTokens: output,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    totalTokens: numberAt(source, "total_tokens") ?? sum(input, output)
  })
}

/**
 * Adds two normalized usages, keeping a field absent only when neither side
 * reported it.
 *
 * @category combinators
 * @since 1.0.0
 */
export const add = (
  left: NormalizedTokenUsage,
  right: NormalizedTokenUsage
): NormalizedTokenUsage =>
  compact({
    inputTokens: sum(left.inputTokens, right.inputTokens),
    outputTokens: sum(left.outputTokens, right.outputTokens),
    reasoningTokens: sum(left.reasoningTokens, right.reasoningTokens),
    cachedInputTokens: sum(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: sum(left.cacheWriteTokens, right.cacheWriteTokens),
    totalTokens: sum(left.totalTokens, right.totalTokens)
  })
