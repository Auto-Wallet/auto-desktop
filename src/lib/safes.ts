// Imported Safe smart accounts.
//
// A Safe has no secret of its own in AutoDesktop. We persist only public
// metadata (contract address, network, owners, threshold, and the chosen local
// owner). Confirmations are signed by the Rust vault / Ledger path, so private
// keys never enter the webview.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isAddress } from "./format";
import { toChecksumAddress } from "./keccak";
import { isTauri } from "./platform";

export type SafeInfo = {
  address: string;
  chainId: string;
  owners: string[];
  threshold: number;
  nonce: string;
};

export type ImportedSafe = SafeInfo & {
  label: string;
  ownerAddress: string;
  serviceUrl: string;
};

export type SafeConfirmation = {
  owner: string;
  signature: string;
};

export type SafeTransaction = {
  safe: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  gasToken: string;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  refundReceiver: string;
  nonce: string | number;
  safeTxHash: string;
  submissionDate?: string;
  origin?: string | null;
  confirmationsRequired: number;
  confirmations: SafeConfirmation[] | null;
  isExecuted: boolean;
};

type SafeTransactionList = {
  count: number;
  results: SafeTransaction[];
};

const STORAGE_KEY = "autodesktop.safeAccounts";

// Safe Infrastructure's unified Transaction Service uses EIP-3770 short names.
// Keep this deliberately small and explicit: unsupported/custom chains ask for a
// custom service URL instead of guessing an endpoint.
const SAFE_SERVICE_PREFIX: Record<string, string> = {
  "0x1": "eth",
  "0x2105": "base",
  "0xa": "oeth",
  "0xa4b1": "arb1",
  "0x89": "pol",
  "0x38": "bnb",
  "0xa86a": "avax",
  "0xe708": "linea",
  "0x144": "zksync",
  "0x44d": "zkevm",
  "0x92": "sonic",
  "0xc4": "okb",
  "0x1e0": "wc",
  "0xa4ec": "celo",
};

function validateStoredSafe(value: unknown): ImportedSafe {
  if (!value || typeof value !== "object") {
    throw new Error("Stored Safe entry is not an object");
  }
  const safe = value as Record<string, unknown>;
  if (
    typeof safe.address !== "string" ||
    typeof safe.chainId !== "string" ||
    typeof safe.label !== "string" ||
    typeof safe.ownerAddress !== "string" ||
    typeof safe.serviceUrl !== "string" ||
    typeof safe.nonce !== "string" ||
    typeof safe.threshold !== "number" ||
    !Array.isArray(safe.owners) ||
    !safe.owners.every((owner) => typeof owner === "string")
  ) {
    throw new Error("Stored Safe entry has an invalid shape");
  }
  return safe as ImportedSafe;
}

function loadSafes(): ImportedSafe[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored Safe accounts must be an array");
  }
  return parsed.map(validateStoredSafe);
}

let safes = loadSafes();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function save(next: ImportedSafe[]) {
  safes = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  emit();
}

export function useSafes(): ImportedSafe[] {
  return useSyncExternalStore(subscribe, () => safes);
}

export function getSafes(): ImportedSafe[] {
  return safes;
}

export function getSafeByAddress(address: string): ImportedSafe | undefined {
  const wanted = address.toLowerCase();
  return safes.find((safe) => safe.address.toLowerCase() === wanted);
}

export function defaultSafeServiceUrl(chainId: string): string | null {
  const prefix = SAFE_SERVICE_PREFIX[chainId.toLowerCase()];
  return prefix
    ? `https://api.safe.global/tx-service/${prefix}/api`
    : null;
}

export function safeWalletUrl(safe: ImportedSafe): string | null {
  const prefix = SAFE_SERVICE_PREFIX[safe.chainId.toLowerCase()];
  return prefix
    ? `https://app.safe.global/transactions/queue?safe=${prefix}:${safe.address}`
    : null;
}

export async function inspectSafe(
  chainId: string,
  address: string,
): Promise<SafeInfo> {
  const trimmed = address.trim();
  if (!isAddress(trimmed)) {
    throw new Error(`Not a valid Safe address: ${address}`);
  }
  if (!isTauri()) {
    const checksum = toChecksumAddress(trimmed);
    return {
      address: checksum,
      chainId,
      owners: [],
      threshold: 2,
      nonce: "0x0",
    };
  }
  const info = await invoke<SafeInfo>("inspect_safe", {
    chainId,
    address: trimmed,
  });
  return {
    ...info,
    address: toChecksumAddress(info.address),
    owners: info.owners.map(toChecksumAddress),
  };
}

export function addSafeAccount(
  info: SafeInfo,
  ownerAddress: string,
  serviceUrl: string,
  label?: string,
): ImportedSafe {
  const address = toChecksumAddress(info.address);
  const owner = toChecksumAddress(ownerAddress);
  if (!info.owners.some((candidate) => candidate.toLowerCase() === owner.toLowerCase())) {
    throw new Error(`${owner} is not an owner of ${address}`);
  }
  if (safes.some((safe) => safe.address.toLowerCase() === address.toLowerCase())) {
    throw new Error("This Safe is already imported");
  }
  const normalizedService = serviceUrl.trim().replace(/\/+$/, "");
  if (!normalizedService) {
    throw new Error("A Safe Transaction Service URL is required");
  }
  const imported: ImportedSafe = {
    ...info,
    address,
    owners: info.owners.map(toChecksumAddress),
    ownerAddress: owner,
    label: label?.trim() || `Safe ${safes.length + 1}`,
    serviceUrl: normalizedService,
  };
  save([...safes, imported]);
  return imported;
}

export function removeSafeAccount(address: string) {
  const wanted = address.toLowerCase();
  save(safes.filter((safe) => safe.address.toLowerCase() !== wanted));
}

export function renameSafeAccount(address: string, label: string) {
  const next = label.trim();
  if (!next) throw new Error("Safe name cannot be empty");
  const wanted = address.toLowerCase();
  save(
    safes.map((safe) =>
      safe.address.toLowerCase() === wanted ? { ...safe, label: next } : safe,
    ),
  );
}

export async function loadSafePendingTransactions(
  safe: ImportedSafe,
): Promise<SafeTransaction[]> {
  if (!isTauri()) return [];
  const response = await invoke<SafeTransactionList>("safe_pending_transactions", {
    serviceUrl: safe.serviceUrl,
    safeAddress: safe.address,
  });
  if (!Array.isArray(response.results)) {
    throw new Error("Safe Transaction Service returned no results array");
  }
  return response.results;
}

export async function confirmSafeTransaction(
  safe: ImportedSafe,
  transaction: SafeTransaction,
): Promise<string> {
  if (!isTauri()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return `0x${"ad".repeat(65)}`;
  }
  return invoke<string>("safe_confirm_transaction", {
    chainId: safe.chainId,
    serviceUrl: safe.serviceUrl,
    safeAddress: safe.address,
    ownerAddress: safe.ownerAddress,
    transaction,
  });
}
