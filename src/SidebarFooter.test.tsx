import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarFooter } from "./SidebarFooter";

describe("SidebarFooter", () => {
  test("contains appearance controls without duplicating the wallet selector", () => {
    const html = renderToStaticMarkup(
      <SidebarFooter collapsed={false} theme="light" onThemeChange={() => undefined} />,
    );

    expect(html).toContain('title="Light"');
    expect(html).toContain('title="Dark"');
    expect(html).not.toContain("acct-foot");
    expect(html).not.toContain("acct-foot-copy");
  });
});
