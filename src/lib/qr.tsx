// Offline QR rendering for the Receive sheet. Uses the tiny, zero-network
// `qrcode-generator` and draws the dark modules as a single crisp SVG path
// (no <img>, no innerHTML) so it stays sharp at any size and in any theme.

import qrcode from "qrcode-generator";

export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const qr = qrcode(0, "M"); // type 0 = auto-fit, error-correction level M
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const margin = 2; // quiet zone (modules)
  const dim = count + margin * 2;

  let path = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) path += `M${c + margin},${r + margin}h1v1h-1z`;
    }
  }

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
