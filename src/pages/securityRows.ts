import type { VaultKind } from "../lib/vault";

export type SecurityRows = {
  ledgerNote: boolean;
  lockNow: boolean;
  changePassword: boolean;
};

/**
 * Which Security rows the Settings page shows. The lock and password rows
 * protect the whole vault, so they follow the vault password, not the kind of
 * account that happens to be active: a Ledger account can sit next to
 * private-key accounts that still need locking.
 */
export function securityRows({
  hasPassword,
  activeKind,
}: {
  hasPassword: boolean;
  activeKind: VaultKind | undefined;
}): SecurityRows {
  const isLedger = activeKind === "ledger";
  const vaultControls = hasPassword || !isLedger;
  return {
    ledgerNote: isLedger,
    lockNow: vaultControls,
    changePassword: vaultControls,
  };
}
