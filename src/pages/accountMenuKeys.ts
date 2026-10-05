/**
 * Whether a key press closes the open account menu. Escape closes it like the
 * network filter menu, except while a rename field or the add-wallet form is
 * open: there Escape only cancels that step.
 */
export function accountMenuClosesOnKey(
  key: string,
  state: { renaming: boolean; adding: boolean },
): boolean {
  return key === "Escape" && !state.renaming && !state.adding;
}
