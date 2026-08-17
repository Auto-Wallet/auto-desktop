import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./icons";

describe("OKX navigation icon", () => {
  test("uses the square two-color brand mark at sidebar size", () => {
    const markup = renderToStaticMarkup(<Icon name="okx" size={19} />);
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('fill="#050505"');
    expect(markup).toContain('fill="#fff"');
    expect(markup).toContain('width="19"');
  });
});
