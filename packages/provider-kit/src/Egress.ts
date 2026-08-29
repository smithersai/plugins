/**
 * The egress policy a sandbox runs under.
 *
 * The rule this module exists to keep is the one case 23 pinned: a sandbox's
 * proxy configuration is delivered *to the sandbox*, never applied to the
 * harness that launched it. A harness that reconfigured its own proxy to run a
 * sandboxed command would route its control-plane traffic through the
 * sandbox's proxy, and every other run in the process with it.
 *
 * Allow and deny are expressed the way every proxy-aware runtime already
 * understands them: `HTTP_PROXY` and `HTTPS_PROXY` name the proxy that decides,
 * and `NO_PROXY` names the hosts that bypass it. A denied host reaches the
 * proxy and is refused there; an allowed host either bypasses or is passed
 * through.
 *
 * @since 1.0.0
 */
import { Result } from "effect"
import { ProviderKitError } from "./ProviderKitError.ts"

/** Where a delivered CA bundle sits inside a request bundle. @since 1.0.0 */
export const caBundleRelativePath = ".smithers/egress/ca.crt"

/** Where a delivered CA bundle sits inside the sandbox workspace. @since 1.0.0 */
export const caWorkspacePath = "/workspace/.smithers/egress/ca.crt"

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/
const maxStringLength = 64 * 1024

/**
 * A normalized egress policy.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly httpProxy?: string | undefined
  readonly httpsProxy?: string | undefined
  /** Comma-separated after normalization, whatever shape it arrived in. */
  readonly noProxy?: string | undefined
  readonly caCertPem?: string | undefined
  readonly caCertPath?: string | undefined
  /** Proxy-side secret bindings, keyed by the token the proxy substitutes. */
  readonly secretBindings?: Readonly<Record<string, string>> | undefined
}

const invalid = (message: string) => Result.fail(new ProviderKitError({ code: "invalid_egress", message }))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalString = (
  value: unknown,
  field: string
): Result.Result<string | undefined, ProviderKitError> => {
  if (value === undefined) return Result.succeed(undefined)
  if (
    typeof value !== "string" || value.length === 0 || value.length > maxStringLength ||
    value.includes("\0")
  ) {
    return invalid(`${field} must be a non-empty string within supported bounds.`)
  }
  return Result.succeed(value)
}

const optionalRecord = (
  value: unknown,
  field: string,
  options: { readonly envKeys?: boolean } = {}
): Result.Result<Readonly<Record<string, string>> | undefined, ProviderKitError> => {
  if (value === undefined) return Result.succeed(undefined)
  if (!isRecord(value)) return invalid(`${field} must be a flat object of string values.`)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (options.envKeys !== false && !environmentName.test(key)) {
      return invalid(`${field} keys must be valid environment variable names.`)
    }
    if (key.length === 0 || key.length > 512 || key.includes("\0")) {
      return invalid(`${field} keys must be strings within supported bounds.`)
    }
    if (typeof entry !== "string" || entry.length > maxStringLength || entry.includes("\0")) {
      return invalid(`${field} values must be strings within supported bounds.`)
    }
    out[key] = entry
  }
  return Result.succeed(out)
}

const noProxyOf = (value: unknown): Result.Result<string | undefined, ProviderKitError> => {
  if (value === undefined) return Result.succeed(undefined)
  if (typeof value === "string") return optionalString(value, "egress.noProxy")
  if (!Array.isArray(value)) return invalid("egress.noProxy must be a string or string array.")
  const parts: Array<string> = []
  for (let index = 0; index < value.length; index += 1) {
    const part = optionalString(value[index], `egress.noProxy[${index}]`)
    if (part._tag === "Failure") return Result.fail(part.failure)
    if (part.success !== undefined) parts.push(part.success)
  }
  return Result.succeed(parts.join(","))
}

/**
 * Validates an egress declaration, answering `undefined` for "no policy".
 *
 * @category constructors
 * @since 1.0.0
 */
export const normalize = (value: unknown): Result.Result<Config | undefined, ProviderKitError> => {
  if (value === undefined || value === null || value === false) return Result.succeed(undefined)
  if (!isRecord(value)) return invalid("Sandbox egress must be an object.")
  const env = optionalRecord(value["env"], "egress.env")
  if (env._tag === "Failure") return Result.fail(env.failure)
  const httpProxy = optionalString(value["httpProxy"], "egress.httpProxy")
  if (httpProxy._tag === "Failure") return Result.fail(httpProxy.failure)
  const httpsProxy = optionalString(value["httpsProxy"], "egress.httpsProxy")
  if (httpsProxy._tag === "Failure") return Result.fail(httpsProxy.failure)
  const noProxy = noProxyOf(value["noProxy"])
  if (noProxy._tag === "Failure") return Result.fail(noProxy.failure)
  const caCertPem = optionalString(value["caCertPem"], "egress.caCertPem")
  if (caCertPem._tag === "Failure") return Result.fail(caCertPem.failure)
  const caCertPath = optionalString(value["caCertPath"], "egress.caCertPath")
  if (caCertPath._tag === "Failure") return Result.fail(caCertPath.failure)
  const secretBindings = optionalRecord(value["secretBindings"], "egress.secretBindings", { envKeys: false })
  if (secretBindings._tag === "Failure") return Result.fail(secretBindings.failure)
  if (caCertPem.success !== undefined && caCertPath.success !== undefined) {
    return invalid("Sandbox egress must use either caCertPem or caCertPath, not both.")
  }
  const config: Config = {
    ...(env.success === undefined || Object.keys(env.success).length === 0 ? {} : { env: env.success }),
    ...(httpProxy.success === undefined ? {} : { httpProxy: httpProxy.success }),
    ...(httpsProxy.success === undefined ? {} : { httpsProxy: httpsProxy.success }),
    ...(noProxy.success === undefined || noProxy.success === "" ? {} : { noProxy: noProxy.success }),
    ...(caCertPem.success === undefined ? {} : { caCertPem: caCertPem.success }),
    ...(caCertPath.success === undefined ? {} : { caCertPath: caCertPath.success }),
    ...(secretBindings.success === undefined || Object.keys(secretBindings.success).length === 0
      ? {}
      : { secretBindings: secretBindings.success })
  }
  return Result.succeed(Object.keys(config).length === 0 ? undefined : config)
}

/**
 * The environment a policy contributes to a sandboxed command.
 *
 * This is the whole delivery mechanism: it is merged into the child's
 * environment and never into the harness's own.
 *
 * @category conversions
 * @since 1.0.0
 */
export const environment = (
  config: Config | undefined,
  options: { readonly caCertPath?: string | undefined } = {}
): Readonly<Record<string, string>> => {
  if (config === undefined) return {}
  const env: Record<string, string> = { ...config.env }
  if (config.httpProxy !== undefined) env["HTTP_PROXY"] = config.httpProxy
  if (config.httpsProxy !== undefined) env["HTTPS_PROXY"] = config.httpsProxy
  if (config.noProxy !== undefined) env["NO_PROXY"] = config.noProxy
  const caPath = config.caCertPath ??
    (config.caCertPem === undefined ? undefined : options.caCertPath ?? caWorkspacePath)
  if (caPath !== undefined) env["NODE_EXTRA_CA_CERTS"] = caPath
  return env
}

/**
 * The values a thrown provider message must never carry.
 *
 * Proxy URLs are included because they routinely embed `user:pass@`.
 *
 * @category getters
 * @since 1.0.0
 */
export const secrets = (
  config: Config | undefined,
  providerEnv: Readonly<Record<string, string>> = {}
): ReadonlyArray<string> => {
  const secretKey = /token|secret|key|password|credential|authorization|passwd|apikey/i
  const out: Array<string> = []
  for (const [key, value] of Object.entries(providerEnv)) {
    if (secretKey.test(key) && value.length > 0) out.push(value)
  }
  for (const value of Object.values(config?.env ?? {})) {
    if (value.length > 0) out.push(value)
  }
  for (const value of [config?.httpProxy, config?.httpsProxy]) {
    if (value !== undefined && value.length > 0) out.push(value)
  }
  return out
}

/**
 * Replaces every secret in a message with a marker.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrub = (text: string, values: ReadonlyArray<string>): string => {
  let out = text
  for (const value of values) {
    if (value !== "") out = out.split(value).join("[redacted]")
  }
  return out
}

/**
 * A loggable form of a policy.
 *
 * Environment keys survive because an operator needs to see which variables a
 * policy sets; every value is hidden, and even a secret binding's *name* is
 * replaced by its position, because a binding name identifies the credential.
 *
 * @category conversions
 * @since 1.0.0
 */
export const redact = (config: Config | undefined): Readonly<Record<string, unknown>> | undefined => {
  if (config === undefined) return undefined
  const out: Record<string, unknown> = {}
  if (config.env !== undefined) {
    out["env"] = Object.fromEntries(Object.keys(config.env).sort().map((key) => [key, "[redacted]"]))
  }
  for (const key of ["httpProxy", "httpsProxy", "noProxy", "caCertPem", "caCertPath"] as const) {
    if (config[key] !== undefined) out[key] = "[redacted]"
  }
  if (config.secretBindings !== undefined) {
    out["secretBindings"] = Object.fromEntries(
      Object.keys(config.secretBindings).sort().map((_, index) => [`binding_${index + 1}`, "[redacted]"])
    )
  }
  return out
}
