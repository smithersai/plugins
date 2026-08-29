/**
 * Local structured-output extraction, validation, and correction diagnostics.
 *
 * Governing contract: `docs/specs/Concepts/Structured Output.md`.
 *
 * @since 0.1.0
 */
import { CanonicalJson } from "@smthrs/model"
import { Effect } from "effect"
import * as AdapterError from "./AdapterError.ts"
import { digest } from "./HarnessCapabilities.ts"

/**
 * JSON Schema material accepted by a CLI adapter.
 *
 * @category models
 * @since 0.1.0
 */
export type JsonSchema = boolean | Readonly<Record<string, unknown>>

/**
 * A fixed schema and correction policy for one CLI attempt.
 *
 * @category models
 * @since 0.1.0
 */
export interface Contract {
  readonly schema: JsonSchema
  readonly schemaDigest: string
  readonly correctionLimit: 1
}

/**
 * The result of extracting and validating one CLI response.
 *
 * @category models
 * @since 0.1.0
 */
export type Validation =
  | {
    readonly _tag: "Valid"
    readonly value: unknown
    readonly candidateDigest: string
  }
  | {
    readonly _tag: "Invalid"
    readonly candidateDigest?: string | undefined
    readonly diagnostics: ReadonlyArray<string>
  }

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const jsonDigest = (value: unknown): string | undefined => {
  try {
    return digest(CanonicalJson.stringify(value))
  } catch {
    return undefined
  }
}

const typeMatches = (type: string, value: unknown): boolean => {
  switch (type) {
    case "null":
      return value === null
    case "boolean":
      return typeof value === "boolean"
    case "object":
      return asRecord(value) !== undefined
    case "array":
      return Array.isArray(value)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
    case "string":
      return typeof value === "string"
    default:
      return true
  }
}

const rendered = (value: unknown): string => {
  try {
    return CanonicalJson.stringify(value)
  } catch {
    return String(value)
  }
}

const validateAt = (
  value: unknown,
  schema: JsonSchema,
  path: string,
  diagnostics: Array<string>
): void => {
  if (diagnostics.length >= 20) return
  if (schema === true) return
  if (schema === false) {
    diagnostics.push(`${path}: schema rejects every value`)
    return
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  if (enumValues !== undefined && !enumValues.some((candidate) => rendered(candidate) === rendered(value))) {
    diagnostics.push(`${path}: expected one of ${enumValues.slice(0, 10).map(rendered).join(", ")}`)
    return
  }
  if ("const" in schema && rendered(schema.const) !== rendered(value)) {
    diagnostics.push(`${path}: expected ${rendered(schema.const)}`)
    return
  }

  const declaredTypes = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : []
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => typeMatches(type, value))) {
    diagnostics.push(`${path}: expected ${declaredTypes.join(" | ")}`)
    return
  }

  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
    ? schema.oneOf
    : undefined
  if (alternatives !== undefined) {
    const matches = alternatives.filter((candidate) => {
      if (candidate !== true && candidate !== false && asRecord(candidate) === undefined) return false
      const branch: Array<string> = []
      validateAt(value, candidate as JsonSchema, path, branch)
      return branch.length === 0
    }).length
    const requiredMatches = Array.isArray(schema.oneOf) ? 1 : Math.max(1, matches)
    if (matches !== requiredMatches) diagnostics.push(`${path}: did not match the declared schema alternatives`)
    return
  }

  const object = asRecord(value)
  if (object !== undefined) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : []
    for (const key of required) {
      if (!(key in object)) diagnostics.push(`${path}.${key}: required property is missing`)
    }
    const properties = asRecord(schema.properties) ?? {}
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in object)) continue
      if (propertySchema !== true && propertySchema !== false && asRecord(propertySchema) === undefined) continue
      validateAt(object[key], propertySchema as JsonSchema, `${path}.${key}`, diagnostics)
    }
    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(properties))
      for (const key of Object.keys(object)) {
        if (!declared.has(key)) diagnostics.push(`${path}.${key}: additional property is not allowed`)
      }
    }
  }

  if (
    Array.isArray(value) && (schema.items === true || schema.items === false || asRecord(schema.items) !== undefined)
  ) {
    for (let index = 0; index < value.length; index++) {
      validateAt(value[index], schema.items as JsonSchema, `${path}[${index}]`, diagnostics)
    }
  }
}

const parseJson = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const balancedCandidates = (text: string): ReadonlyArray<string> => {
  const candidates: Array<{ readonly text: string; readonly close: number }> = []
  const stack: Array<{ readonly character: "{" | "["; readonly index: number }> = []
  let quote = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === "\"") quote = false
      continue
    }
    if (character === "\"") {
      quote = true
      continue
    }
    if (character === "{" || character === "[") {
      stack.push({ character, index })
      continue
    }
    if (character !== "}" && character !== "]") continue
    const opened = stack.at(-1)
    if (opened === undefined || (opened.character === "{" ? character !== "}" : character !== "]")) {
      stack.length = 0
      continue
    }
    stack.pop()
    if (stack.length === 0) candidates.push({ text: text.slice(opened.index, index + 1), close: index })
  }
  return candidates.sort((left, right) => right.close - left.close).map((candidate) => candidate.text)
}

const candidates = (value: unknown): ReadonlyArray<unknown> => {
  if (typeof value !== "string") return [value]
  const text = value.replace(/^\uFEFF/, "").trim()
  const complete = parseJson(text)
  const extracted = balancedCandidates(text).flatMap((candidate) => {
    const parsed = parseJson(candidate)
    return parsed === undefined ? [] : [parsed]
  })
  return complete === undefined ? extracted : [complete, ...extracted]
}

/**
 * Constructs a canonical one-correction structured-output contract.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (schema: JsonSchema): Contract => ({
  schema,
  schemaDigest: digest(CanonicalJson.stringify(schema)),
  correctionLimit: 1
})

/**
 * Strictens a schema for a vendor that consumes OpenAI's structured-output
 * dialect.
 *
 * Codex reads its `--output-schema` file and Claude Code its `--json-schema`
 * file in that dialect, which imposes three rules beyond JSON Schema:
 *
 * 1. Every object node carries `"type": "object"`.
 * 2. Every object node sets `additionalProperties: false`.
 * 3. Under that flag, every declared property is also listed in `required` —
 *    strict mode has no optional properties, so a genuinely optional field is
 *    modeled as nullable instead.
 *
 * Effect Schema and Zod both emit schemas that break all three for a loose
 * object, and the vendor rejects the file rather than degrading, so a caller
 * writing a schema file passes it through here first.
 *
 * This is deliberately not what {@link renderSchema} produces. The prompt
 * teaches the shape the caller declared; telling the model that every optional
 * field is required would make it invent values the caller did not ask for.
 *
 * The argument is not modified: a caller's declared schema stays the one the
 * local validator reads.
 *
 * @category constructors
 * @since 1.0.0
 */
export const vendorSchema = (schema: JsonSchema): JsonSchema => {
  if (schema === true || schema === false) return schema
  const record = asRecord(schema)
  if (record === undefined) return schema

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item === true || item === false || asRecord(item) !== undefined ? vendorSchema(item as JsonSchema) : item
      )
      continue
    }
    const nested = asRecord(value)
    out[key] = nested === undefined ? value : vendorSchema(nested)
  }

  // Rule 1: a node that constrains its properties is an object, whether or not
  // the emitter said so.
  if (("additionalProperties" in out || "properties" in out) && !("type" in out)) out["type"] = "object"
  if (out["type"] !== "object") return out
  // Rule 2.
  out["additionalProperties"] = false
  // Rule 3.
  const properties = asRecord(out["properties"])
  if (properties !== undefined) out["required"] = Object.keys(properties)
  return out
}

/**
 * Renders the exact schema supplied to the local validator.
 *
 * @category formatting
 * @since 0.1.0
 */
export const renderSchema = (contract: Contract): string => JSON.stringify(contract.schema, null, 2)

/**
 * Renders the schema file a vendor reads, strictened by {@link vendorSchema}.
 *
 * This is what goes at `outputSchemaPath` — Codex's `--output-schema`, Claude
 * Code's `--json-schema`. {@link renderSchema} is what goes in the prompt.
 *
 * @category formatting
 * @since 1.0.0
 */
export const renderVendorSchema = (contract: Contract): string =>
  JSON.stringify(vendorSchema(contract.schema), null, 2)

/**
 * Extracts complete or rightmost balanced JSON and validates it locally.
 *
 * @category validation
 * @since 0.1.0
 */
export const validate = (value: unknown, contract: Contract): Validation => {
  let lastDigest: string | undefined
  let lastDiagnostics: ReadonlyArray<string> = ["$: response did not contain valid JSON"]
  for (const candidate of candidates(value)) {
    lastDigest = jsonDigest(candidate)
    const diagnostics: Array<string> = []
    validateAt(candidate, contract.schema, "$", diagnostics)
    if (diagnostics.length === 0 && lastDigest !== undefined) {
      return { _tag: "Valid", value: candidate, candidateDigest: lastDigest }
    }
    lastDiagnostics = diagnostics.slice(0, 5)
  }
  return {
    _tag: "Invalid",
    ...(lastDigest === undefined ? {} : { candidateDigest: lastDigest }),
    diagnostics: lastDiagnostics
  }
}

/**
 * Renders the bounded correction prompt for one invalid candidate.
 *
 * @category formatting
 * @since 0.1.0
 */
export const correctionPrompt = (contract: Contract, validation: Extract<Validation, { _tag: "Invalid" }>): string =>
  [
    "Return only one corrected JSON value that satisfies this exact schema.",
    renderSchema(contract),
    "Validation diagnostics:",
    ...validation.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n")

/**
 * Constructs the terminal typed failure after the correction slot is spent.
 *
 * @category constructors
 * @since 0.1.0
 */
export const failure = (
  contract: Contract,
  validation: Extract<Validation, { _tag: "Invalid" }>,
  correctionCount: number
): AdapterError.StructuredOutputFailure =>
  new AdapterError.StructuredOutputFailure({
    message: "CLI response did not satisfy the declared output schema",
    schemaDigest: contract.schemaDigest,
    correctionCount,
    correctionLimit: contract.correctionLimit,
    ...(validation.candidateDigest === undefined ? {} : { candidateDigest: validation.candidateDigest }),
    diagnostics: [...validation.diagnostics]
  })

/**
 * Fails with the stable typed structured-output error when validation fails.
 *
 * @category validation
 * @since 0.1.0
 */
export const decode = (
  value: unknown,
  contract: Contract,
  correctionCount: number
): Effect.Effect<unknown, AdapterError.StructuredOutputFailure> => {
  const validation = validate(value, contract)
  return validation._tag === "Valid"
    ? Effect.succeed(validation.value)
    : Effect.fail(failure(contract, validation, correctionCount))
}
