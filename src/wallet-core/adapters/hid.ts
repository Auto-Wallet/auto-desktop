/**
 * Raw HID transport for hardware wallets (Ledger). AutoDesktop uses a Rust
 * `hidapi` bridge because WKWebView has no WebHID. Shaped to back a transport
 * whose `exchange()` sends an APDU and returns the device response.
 */
export interface HidTransport {
  /** Whether a hardware-wallet transport is usable on this platform right now. */
  isAvailable(): Promise<boolean>;

  /** Open a session to the device (prompt/select as needed). */
  open(): Promise<void>;

  /** Send a raw APDU (hex, no length prefix) and resolve the response (hex). */
  exchange(apduHex: string): Promise<string>;

  /** Close the device session. */
  close(): Promise<void>;
}
