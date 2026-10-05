import { describe, expect, test } from "bun:test";
import { accountMenuClosesOnKey } from "./accountMenuKeys";

const idle = { renaming: false, adding: false };

describe("accountMenuClosesOnKey", () => {
  test("Escape closes the open account menu", () => {
    expect(accountMenuClosesOnKey("Escape", idle)).toBe(true);
  });

  test("other keys leave it open", () => {
    for (const key of ["Enter", "Tab", "a", "ArrowDown"]) {
      expect(accountMenuClosesOnKey(key, idle)).toBe(false);
    }
  });

  test("Escape only cancels a rename or the add-wallet form, not the whole menu", () => {
    expect(accountMenuClosesOnKey("Escape", { renaming: true, adding: false })).toBe(false);
    expect(accountMenuClosesOnKey("Escape", { renaming: false, adding: true })).toBe(false);
  });
});
