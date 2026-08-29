/**
 * The model families a provider caps separately.
 *
 * A quota block recorded against one family must not idle the others, so a
 * block carries the family it was observed on and `shared` means every model.
 *
 * @since 1.0.0
 */

/**
 * The family a model id belongs to, or `shared` when nothing caps it alone.
 *
 * @category conversions
 * @since 1.0.0
 */
export const modelFamily = (model: string | undefined): string => {
  const value = model?.toLowerCase() ?? ""
  if (value.includes("fable")) return "fable"
  if (value.includes("opus")) return "opus"
  if (value.includes("sonnet")) return "sonnet"
  return "shared"
}
