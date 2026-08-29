/**
 * Token accounting across vendor spellings.
 */
import { describe, expect, it } from "vitest"
import * as Usage from "../src/Usage.ts"

describe("Usage.normalize", () => {
  it("reads camelCase, snake_case, and the OpenAI spelling", () => {
    expect(Usage.normalize({ inputTokens: 1, outputTokens: 2 })).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(Usage.normalize({ input_tokens: 3, output_tokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4 })
    expect(Usage.normalize({ prompt_tokens: 5, completion_tokens: 6 })).toEqual({
      inputTokens: 5,
      outputTokens: 6
    })
  })

  it("unwraps a nested usage object", () => {
    expect(Usage.normalize({ usage: { prompt_tokens: 7 } })).toEqual({ inputTokens: 7 })
  })

  it("reads reasoning and cached counts out of their detail objects", () => {
    const usage = Usage.normalize({
      prompt_tokens: 10,
      completion_tokens: 4,
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_tokens_details: { cached_tokens: 6 }
    })

    expect(usage).toMatchObject({ reasoningTokens: 3, cachedInputTokens: 6 })
  })

  it("leaves a number the vendor never reported absent rather than zero", () => {
    expect(Usage.normalize({ prompt_tokens: 1 })).toEqual({ inputTokens: 1 })
    expect(Usage.normalize(undefined)).toEqual({})
    expect(Usage.normalize("nope")).toEqual({})
  })

  it("ignores a non-finite count", () => {
    expect(Usage.normalize({ prompt_tokens: Number.NaN })).toEqual({})
  })
})

describe("Usage.deepseek", () => {
  it("treats the cache hit as a subset of the prompt, not an addition", () => {
    const usage = Usage.deepseek({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 80,
      completion_tokens: 10,
      total_tokens: 110
    })

    expect(usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 10,
      totalTokens: 110
    })
  })
})

describe("Usage.kimiWire", () => {
  it("reads the cached count nested one level deeper", () => {
    expect(Usage.kimiWire({ usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } }))
      .toMatchObject({ inputTokens: 5, cachedInputTokens: 2 })
  })

  it("computes a total the vendor omitted", () => {
    expect(Usage.kimiWire({ prompt_tokens: 5, completion_tokens: 3 }).totalTokens).toBe(8)
  })
})

describe("Usage.add", () => {
  it("keeps a field absent only when neither side reported it", () => {
    expect(Usage.add({ inputTokens: 1 }, { inputTokens: 2, outputTokens: 3 })).toEqual({
      inputTokens: 3,
      outputTokens: 3
    })
    expect(Usage.add({}, {})).toEqual({})
  })
})
