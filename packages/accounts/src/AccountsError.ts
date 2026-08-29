/**
 * Typed failures of the account registry.
 *
 * The plugins repository defines its own errors as `Schema.TaggedError`
 * classes rather than depending on a shared error package, so a caller
 * discriminates on `_tag` and a failure survives a journal round trip.
 *
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * The accounts file exists but cannot be read as a registry.
 *
 * @category errors
 * @since 1.0.0
 */
export class AccountsFileInvalid extends Schema.TaggedError<AccountsFileInvalid>()(
  "@smthrs-plugins/accounts/AccountsFileInvalid",
  { message: Schema.String }
) {}

/**
 * An account was rejected before it reached disk.
 *
 * @category errors
 * @since 1.0.0
 */
export class AccountInvalid extends Schema.TaggedError<AccountInvalid>()(
  "@smthrs-plugins/accounts/AccountInvalid",
  { message: Schema.String }
) {}

/**
 * A label already names a registered account.
 *
 * @category errors
 * @since 1.0.0
 */
export class AccountDuplicateLabel extends Schema.TaggedError<AccountDuplicateLabel>()(
  "@smthrs-plugins/accounts/AccountDuplicateLabel",
  { label: Schema.String, message: Schema.String }
) {}

/**
 * No account carries the requested label.
 *
 * @category errors
 * @since 1.0.0
 */
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "@smthrs-plugins/accounts/AccountNotFound",
  { label: Schema.String, message: Schema.String }
) {}

/**
 * The registry could not be locked for a read-modify-write.
 *
 * @category errors
 * @since 1.0.0
 */
export class AccountsLocked extends Schema.TaggedError<AccountsLocked>()(
  "@smthrs-plugins/accounts/AccountsLocked",
  { path: Schema.String, message: Schema.String }
) {}

/**
 * Every failure the registry raises.
 *
 * @category errors
 * @since 1.0.0
 */
export type AccountsError =
  | AccountsFileInvalid
  | AccountInvalid
  | AccountDuplicateLabel
  | AccountNotFound
  | AccountsLocked
