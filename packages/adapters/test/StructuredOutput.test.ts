import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as StructuredOutput from "../src/StructuredOutput.ts"

const contractFor = (schema: StructuredOutput.JsonSchema): StructuredOutput.Contract => StructuredOutput.make(schema)

const invalid = (
  value: unknown,
  schema: StructuredOutput.JsonSchema
): Extract<StructuredOutput.Validation, { _tag: "Invalid" }> => {
  const validation = StructuredOutput.validate(value, contractFor(schema))
  if (validation._tag === "Valid") throw new Error(`expected an invalid validation, got ${JSON.stringify(validation)}`)
  return validation
}

const valid = (value: unknown, schema: StructuredOutput.JsonSchema): unknown => {
  const validation = StructuredOutput.validate(value, contractFor(schema))
  if (validation._tag === "Invalid") {
    throw new Error(`expected a valid validation, got ${JSON.stringify(validation.diagnostics)}`)
  }
  return validation.value
}

describe("StructuredOutput", () => {
  describe("make", () => {
    it("pins a one-correction contract with a content-addressed schema digest", () => {
      const contract = StructuredOutput.make({ type: "object" })
      expect(contract.correctionLimit).toBe(1)
      expect(contract.schemaDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(contract.schema).toEqual({ type: "object" })
    })

    it("derives the same digest for canonically equal schemas and a different one otherwise", () => {
      const left = StructuredOutput.make({ type: "object", properties: { a: { type: "string" } } })
      const right = StructuredOutput.make({ properties: { a: { type: "string" } }, type: "object" })
      const other = StructuredOutput.make({ type: "object", properties: { a: { type: "number" } } })
      expect(left.schemaDigest).toBe(right.schemaDigest)
      expect(left.schemaDigest).not.toBe(other.schemaDigest)
    })
  })

  describe("type checking", () => {
    it("distinguishes integer from fractional and non-finite numbers", () => {
      expect(valid(7, { type: "integer" })).toBe(7)
      expect(invalid(7.5, { type: "integer" }).diagnostics).toEqual(["$: expected integer"])
      expect(valid(7.5, { type: "number" })).toBe(7.5)
      expect(invalid(Number.POSITIVE_INFINITY, { type: "number" }).diagnostics).toEqual(["$: expected number"])
      expect(invalid(Number.NaN, { type: "number" }).diagnostics).toEqual(["$: expected number"])
    })

    it("separates null, arrays, and objects", () => {
      expect(valid(null, { type: "null" })).toBe(null)
      expect(invalid(null, { type: "object" }).diagnostics).toEqual(["$: expected object"])
      expect(invalid([], { type: "object" }).diagnostics).toEqual(["$: expected object"])
      expect(valid([], { type: "array" })).toEqual([])
      expect(invalid({}, { type: "array" }).diagnostics).toEqual(["$: expected array"])
      expect(valid(true, { type: "boolean" })).toBe(true)
      expect(invalid(1, { type: "boolean" }).diagnostics).toEqual(["$: expected boolean"])
      expect(valid("\"x\"", { type: "string" })).toBe("x")
    })

    it("accepts any member of a declared type union and reports the whole union otherwise", () => {
      const schema = { type: ["string", "null"] }
      expect(valid("\"x\"", schema)).toBe("x")
      expect(valid(null, schema)).toBe(null)
      expect(invalid(1, schema).diagnostics).toEqual(["$: expected string | null"])
    })

    it("treats an unrecognized declared type as unconstrained", () => {
      expect(valid({ any: true }, { type: "widget" })).toEqual({ any: true })
    })

    it("accepts every value for the boolean-true schema and rejects every value for false", () => {
      expect(valid({ any: 1 }, true)).toEqual({ any: 1 })
      expect(invalid({ any: 1 }, false).diagnostics).toEqual(["$: schema rejects every value"])
    })
  })

  describe("enum and const", () => {
    it("compares enum members canonically and bounds the rendered alternatives", () => {
      expect(valid({ a: 1 }, { enum: [{ a: 1 }, "other"] })).toEqual({ a: 1 })
      expect(invalid("\"missing\"", { enum: ["a", "b"] }).diagnostics).toEqual([`$: expected one of "a", "b"`])
      const many = invalid("\"missing\"", { enum: Array.from({ length: 30 }, (_, index) => index) })
      expect(many.diagnostics[0]).toBe("$: expected one of 0, 1, 2, 3, 4, 5, 6, 7, 8, 9")
    })

    it("compares const canonically", () => {
      expect(valid(true, { const: true })).toBe(true)
      expect(invalid(false, { const: true }).diagnostics).toEqual(["$: expected true"])
    })
  })

  describe("composition", () => {
    it("requires at least one anyOf branch to match", () => {
      const schema = { anyOf: [{ type: "string" }, { type: "number" }] }
      expect(valid("\"x\"", schema)).toBe("x")
      expect(valid(1, schema)).toBe(1)
      expect(invalid(null, schema).diagnostics).toEqual(["$: did not match the declared schema alternatives"])
    })

    it("requires exactly one oneOf branch to match", () => {
      const exclusive = { oneOf: [{ type: "string" }, { type: "number" }] }
      expect(valid("\"x\"", exclusive)).toBe("x")
      const ambiguous = { oneOf: [{ type: "integer" }, { type: "number" }] }
      expect(invalid(1, ambiguous).diagnostics).toEqual(["$: did not match the declared schema alternatives"])
    })

    it("ignores non-schema alternatives instead of treating them as matches", () => {
      expect(invalid(1, { anyOf: ["not-a-schema", 42] }).diagnostics).toEqual([
        "$: did not match the declared schema alternatives"
      ])
    })
  })

  describe("objects and arrays", () => {
    it("reports each missing required property at its path", () => {
      const validation = invalid({ a: 1 }, { type: "object", required: ["a", "b", "c"] })
      expect(validation.diagnostics).toEqual([
        "$.b: required property is missing",
        "$.c: required property is missing"
      ])
    })

    it("rejects a candidate that cannot be canonically digested even with no diagnostics", () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const validation = StructuredOutput.validate(circular, contractFor(true))
      expect(validation._tag).toBe("Invalid")
      if (validation._tag !== "Invalid") return
      expect(validation.diagnostics).toEqual([])
      expect(validation.candidateDigest).toBeUndefined()
    })

    it("validates declared properties recursively and skips absent ones", () => {
      const schema = {
        type: "object",
        properties: { nested: { type: "object", properties: { n: { type: "integer" } } } }
      }
      expect(valid({}, schema)).toEqual({})
      expect(invalid({ nested: { n: "x" } }, schema).diagnostics).toEqual(["$.nested.n: expected integer"])
    })

    it("rejects undeclared properties only when additionalProperties is false", () => {
      const closed = { type: "object", properties: { a: {} }, additionalProperties: false }
      expect(invalid({ a: 1, b: 2 }, closed).diagnostics).toEqual(["$.b: additional property is not allowed"])
      const open = { type: "object", properties: { a: {} } }
      expect(valid({ a: 1, b: 2 }, open)).toEqual({ a: 1, b: 2 })
    })

    it("validates every array item at its index", () => {
      const schema = { type: "array", items: { type: "integer" } }
      expect(valid([1, 2], schema)).toEqual([1, 2])
      expect(invalid([1, "x", 3.5], schema).diagnostics).toEqual([
        "$[1]: expected integer",
        "$[2]: expected integer"
      ])
    })

    it("bounds the reported diagnostics for a wide failure", () => {
      const schema = {
        type: "array",
        items: { type: "integer" }
      }
      const validation = invalid(Array.from({ length: 50 }, () => "x"), schema)
      expect(validation.diagnostics).toHaveLength(5)
      expect(validation.diagnostics[0]).toBe("$[0]: expected integer")
    })
  })

  describe("candidate extraction", () => {
    it("accepts a bare JSON document", () => {
      expect(valid("{\"ok\":true}", { type: "object", required: ["ok"] })).toEqual({ ok: true })
    })

    it("strips a byte-order mark and surrounding whitespace", () => {
      expect(valid("﻿\n  {\"ok\":true}\n ", { type: "object", required: ["ok"] })).toEqual({ ok: true })
    })

    it("prefers the rightmost balanced JSON value embedded in prose", () => {
      const text = "Here is a draft {\"ok\":1} and the final answer {\"ok\":2}."
      expect(valid(text, { type: "object", required: ["ok"] })).toEqual({ ok: 2 })
    })

    it("falls back to an earlier candidate when the rightmost one does not validate", () => {
      const text = "answer {\"ok\":true} then a trailing note {\"other\":1}"
      const schema = {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false
      }
      expect(valid(text, schema)).toEqual({ ok: true })
    })

    it("never accepts a prose response as a bare JSON string value", () => {
      expect(invalid("plain prose", { type: "string" }).diagnostics).toEqual([
        "$: response did not contain valid JSON"
      ])
    })

    it("ignores braces inside JSON strings when finding candidates", () => {
      expect(valid("prefix {\"ok\":\"a } b {\"} suffix", { type: "object", required: ["ok"] })).toEqual({
        ok: "a } b {"
      })
    })

    it("ignores escaped quotes inside JSON strings", () => {
      expect(valid("noise {\"ok\":\"say \\\"hi\\\"\"} noise", { type: "object", required: ["ok"] })).toEqual({
        ok: "say \"hi\""
      })
    })

    it("extracts a balanced array candidate", () => {
      expect(valid("the list is [1, 2, 3]", { type: "array", items: { type: "integer" } })).toEqual([1, 2, 3])
    })

    it("recovers after a mismatched closing delimiter", () => {
      expect(valid("garbage ] then {\"ok\":true}", { type: "object", required: ["ok"] })).toEqual({ ok: true })
    })

    it("reports a JSON-free response with the no-JSON diagnostic", () => {
      const validation = invalid("I could not answer.", { type: "object" })
      expect(validation.diagnostics).toEqual(["$: response did not contain valid JSON"])
      expect(validation.candidateDigest).toBeUndefined()
    })

    it("validates a non-string value directly without extraction", () => {
      expect(valid({ ok: true }, { type: "object", required: ["ok"] })).toEqual({ ok: true })
      const validation = invalid({ ok: true }, { type: "array" })
      expect(validation.diagnostics).toEqual(["$: expected array"])
      expect(validation.candidateDigest).toMatch(/^[0-9a-f]{64}$/)
    })

    it("carries a candidate digest on a valid result", () => {
      const validation = StructuredOutput.validate("{\"ok\":true}", contractFor({ type: "object" }))
      expect(validation._tag).toBe("Valid")
      if (validation._tag !== "Valid") return
      expect(validation.candidateDigest).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe("correction and failure", () => {
    it("renders the exact schema and diagnostics in the correction prompt", () => {
      const contract = contractFor({ type: "object", required: ["ok"] })
      const validation = invalid({ nope: 1 }, { type: "object", required: ["ok"] })
      const prompt = StructuredOutput.correctionPrompt(contract, validation)
      expect(prompt).toContain("Return only one corrected JSON value that satisfies this exact schema.")
      expect(prompt).toContain(StructuredOutput.renderSchema(contract))
      expect(prompt).toContain("Validation diagnostics:")
      expect(prompt).toContain("- $.ok: required property is missing")
    })

    it("builds a terminal failure carrying the schema digest, budget, and diagnostics", () => {
      const contract = contractFor({ type: "object", required: ["ok"] })
      const validation = invalid({ nope: 1 }, { type: "object", required: ["ok"] })
      const failure = StructuredOutput.failure(contract, validation, 1)
      expect(failure._tag).toBe("flows/adapters/StructuredOutputFailure")
      expect(failure.code).toBe("structured_output_failed")
      expect(failure.schemaDigest).toBe(contract.schemaDigest)
      expect(failure.correctionCount).toBe(1)
      expect(failure.correctionLimit).toBe(1)
      expect(failure.candidateDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(failure.diagnostics).toEqual(["$.ok: required property is missing"])
    })

    it("omits the candidate digest when no candidate could be digested", () => {
      const contract = contractFor({ type: "object" })
      const validation = invalid("no json here", { type: "object" })
      expect(StructuredOutput.failure(contract, validation, 0).candidateDigest).toBeUndefined()
    })

    it("decodes a valid response and fails a repeatedly invalid one", () => {
      const contract = contractFor({ type: "object", required: ["ok"] })
      expect(Effect.runSync(StructuredOutput.decode("{\"ok\":true}", contract, 0))).toEqual({ ok: true })

      const exit = Effect.runSyncExit(StructuredOutput.decode("nope", contract, 1))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Effect.runSync(Effect.flip(StructuredOutput.decode("nope", contract, 1)))
      expect(error.correctionCount).toBe(1)
      expect(error.message).toBe("CLI response did not satisfy the declared output schema")
      expect(error.diagnostics).toEqual(["$: response did not contain valid JSON"])
    })
  })
})
