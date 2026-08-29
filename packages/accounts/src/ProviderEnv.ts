/**
 * The canonical account-to-environment mapping.
 *
 * A subscription account is a directory the vendor CLI reads, and every vendor
 * names that directory with its own variable. This module is the one place
 * that knows the names; the usage reader and the seat resolver import it
 * rather than repeating it, which is how the 0.x drift between three copies of
 * this table is closed.
 *
 * @since 1.0.0
 */
import { Result } from "effect"
import type { Account } from "./Account.ts"
import { AccountInvalid } from "./AccountsError.ts"

/**
 * The environment variable each subscription provider reads its configuration
 * directory from.
 *
 * @category models
 * @since 1.0.0
 */
export const configDirVariable = Object.freeze({
  "claude-code": "CLAUDE_CONFIG_DIR",
  "antigravity": "GEMINI_DIR",
  "codex": "CODEX_HOME",
  "kimi": "KIMI_SHARE_DIR",
  "grok": "GROK_HOME"
} as const)

/**
 * The environment variable each API provider reads its key from.
 *
 * @category models
 * @since 1.0.0
 */
export const apiKeyVariable = Object.freeze({
  "anthropic-api": "ANTHROPIC_API_KEY",
  "openai-api": "OPENAI_API_KEY",
  "gemini-api": "GEMINI_API_KEY",
  "xai-api": "XAI_API_KEY"
} as const)

/**
 * Projects one account into the environment its provider CLI honors.
 *
 * An API account with no key yields an empty environment on purpose: the key
 * is then expected from the ambient environment, which is how an operator
 * keeps a secret out of the registry file.
 *
 * @category conversions
 * @since 1.0.0
 */
export const accountToProviderEnv = (
  account: Account
): Result.Result<Readonly<Record<string, string>>, AccountInvalid> => {
  if (account.provider in configDirVariable) {
    const variable = configDirVariable[account.provider as keyof typeof configDirVariable]
    if (account.configDir === undefined || account.configDir.trim() === "") {
      return Result.fail(
        new AccountInvalid({ message: `${account.provider} account "${account.label}" is missing configDir` })
      )
    }
    return Result.succeed({ [variable]: account.configDir })
  }
  const variable = apiKeyVariable[account.provider as keyof typeof apiKeyVariable]
  if (variable === undefined) {
    return Result.fail(new AccountInvalid({ message: `unknown provider: ${String(account.provider)}` }))
  }
  return Result.succeed(
    account.apiKey === undefined || account.apiKey === "" ? {} : { [variable]: account.apiKey }
  )
}
