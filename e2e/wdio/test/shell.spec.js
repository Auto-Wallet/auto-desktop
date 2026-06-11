import assert from 'node:assert/strict';

// The app is multi-webview: the WebDriver session exposes the shell (and any
// dapp webviews) as separate window handles, so scan them for the React shell.
describe('AutoDesktop shell', () => {
  it('boots and renders the React shell UI', async () => {
    const handles = await browser.getWindowHandles();
    let shellHtml = null;
    for (const handle of handles) {
      await browser.switchToWindow(handle);
      const root = await $('#root');
      if (await root.isExisting()) {
        const html = await root.getHTML();
        // A populated #root proves React mounted; an empty div means the shell
        // webview loaded but the UI crashed on boot.
        if (html.length > 200) {
          shellHtml = html;
          break;
        }
      }
    }
    assert.ok(
      shellHtml,
      `no webview rendered a populated #root (window handles seen: ${handles.length})`,
    );
  });
});
