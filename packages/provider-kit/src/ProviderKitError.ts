/**
 * The typed failure the provider kit raises.
 *
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * A provider-kit failure, discriminated by `code` so a caller can tell an
 * invalid declaration from a remote execution fault.
 *
 * @category errors
 * @since 1.0.0
 */
export class ProviderKitError extends Schema.TaggedError<ProviderKitError>()(
  "@smthrs-plugins/provider-kit/ProviderKitError",
  {
    code: Schema.Literals(["invalid_egress", "invalid_options", "path_escape", "remote_failed"]),
    message: Schema.String,
    provider: Schema.optional(Schema.String)
  }
) {}
