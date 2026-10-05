import { describe, expect, test } from "bun:test";
import { securityRows } from "./securityRows";

describe("securityRows", () => {
  test("a Ledger account in a password vault still offers lock and password rows", () => {
    // The vault also holds private-key accounts; picking a Ledger account must
    // not hide the controls that lock them.
    expect(securityRows({ hasPassword: true, activeKind: "ledger" })).toEqual({
      ledgerNote: true,
      lockNow: true,
      changePassword: true,
    });
  });

  test("a Ledger-only vault without a password shows only the Ledger note", () => {
    expect(securityRows({ hasPassword: false, activeKind: "ledger" })).toEqual({
      ledgerNote: true,
      lockNow: false,
      changePassword: false,
    });
  });

  test("software accounts keep lock and password rows without the Ledger note", () => {
    // undefined: a watch-only or Safe account, which has no vault wallet.
    for (const activeKind of ["hd", "privkey", undefined] as const) {
      expect(securityRows({ hasPassword: true, activeKind })).toEqual({
        ledgerNote: false,
        lockNow: true,
        changePassword: true,
      });
    }
  });
});
