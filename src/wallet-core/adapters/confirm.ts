/**
 * User approval for dApp-originated actions. AutoDesktop opens a dedicated,
 * always-on-top approval window because native child webviews render above HTML,
 * so an in-shell modal would be hidden behind the dApp webview.
 */
export type ConfirmKind =
  | 'connect'
  | 'signMessage'
  | 'signTypedData'
  | 'sendTransaction'
  | 'addChain'
  | 'switchChain';

export interface ConfirmRequest {
  id: string;
  kind: ConfirmKind;
  /** dApp origin requesting the action (trusted, backend-verified). */
  origin: string;
  /** Action-specific data (tx, message, chain params, …). */
  payload: unknown;
}

export interface ConfirmResult {
  approved: boolean;
  /** Optional data the approval UI returns (e.g. an edited fee). */
  payload?: unknown;
}

export interface ConfirmAdapter {
  requestConfirmation(req: ConfirmRequest): Promise<ConfirmResult>;
}
