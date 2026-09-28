import { afterEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { disconnectSite, loadConnectedSites } from "./connectedSites";

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

afterEach(() => clearMocks());

describe("connected sites bridge", () => {
  test("loads the list from the backend", async () => {
    mockIPC((command) => {
      if (command === "get_connected_sites") return ["https://a.example", "https://b.example"];
      throw new Error(`unexpected ${command}`);
    });
    expect(await loadConnectedSites()).toEqual(["https://a.example", "https://b.example"]);
  });

  test("disconnects by origin, then reloads", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    let sites = ["https://a.example", "https://b.example"];
    mockIPC((command, args) => {
      calls.push({ command, args });
      if (command === "disconnect_connected_site") {
        const origin = (args as { origin: string }).origin;
        sites = sites.filter((s) => s !== origin);
        return null;
      }
      if (command === "get_connected_sites") return sites;
      throw new Error(`unexpected ${command}`);
    });
    expect(await disconnectSite("https://a.example")).toEqual(["https://b.example"]);
    expect(calls[0]).toEqual({
      command: "disconnect_connected_site",
      args: { origin: "https://a.example" },
    });
  });
});
