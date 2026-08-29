/**
 * Which Vercel credential a sandbox is created with.
 *
 * The order is not arbitrary. An explicitly configured OIDC token is the most
 * specific thing a caller can say, so it wins; the ambient `VERCEL_OIDC_TOKEN`
 * is next, because a workload identity is meant to be picked up without
 * configuration; a personal access token needs its team and project to
 * identify anything, so it is only used when all three are present. When
 * nothing is configured this answers an empty object rather than failing,
 * which lets the SDK do its own environment discovery.
 *
 * @since 1.0.0
 */
import type { Credentials } from "./Sdk.ts"

/**
 * How a caller names a credential.
 *
 * @category models
 * @since 1.0.0
 */
export interface Input {
  readonly oidcToken?: string | undefined
  readonly token?: string | undefined
  readonly teamId?: string | undefined
  readonly projectId?: string | undefined
}

/**
 * Resolves the credential, reading the environment the caller supplies rather
 * than `process.env`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = (
  input: Input = {},
  env: Readonly<Record<string, string | undefined>> = {}
): Credentials => {
  const oidcToken = input.oidcToken ?? env["VERCEL_OIDC_TOKEN"]
  if (oidcToken !== undefined && oidcToken !== "") return { token: oidcToken }
  const token = input.token ?? env["VERCEL_TOKEN"]
  const teamId = input.teamId ?? env["VERCEL_TEAM_ID"]
  const projectId = input.projectId ?? env["VERCEL_PROJECT_ID"]
  if (
    token !== undefined && token !== "" && teamId !== undefined && teamId !== "" &&
    projectId !== undefined && projectId !== ""
  ) {
    return { token, teamId, projectId }
  }
  return {}
}
