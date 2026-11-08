/**
 * Inline SVG icon set.
 *
 * Strokes drawn with `currentColor`, so an icon always takes the colour of the
 * text around it (accent, dim, danger) with no second asset and no tinted PNG
 * per state. 24×24 viewBox at a 1.8 stroke — the same visual weight as the
 * hairline borders in the design system.
 */
import type { SVGProps } from "react";

function stroke(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

/** Outgoing payment: an arrow leaving the wallet. */
export function SendIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

/** Incoming payment: an arrow arriving. */
export function ReceiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </svg>
  );
}

/** QR scanning: a viewfinder with a scan line. */
export function ScanIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke(props)}>
      <path d="M4 9V6a2 2 0 0 1 2-2h3" />
      <path d="M15 4h3a2 2 0 0 1 2 2v3" />
      <path d="M20 15v3a2 2 0 0 1-2 2h-3" />
      <path d="M9 20H6a2 2 0 0 1-2-2v-3" />
      <path d="M4 12h16" />
    </svg>
  );
}

/** Locked wallet. */
export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke(props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** Biometric unlock: a face inside a sensor square. */
export function BiometricIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke(props)}>
      <path d="M4 9V6a2 2 0 0 1 2-2h3" />
      <path d="M15 4h3a2 2 0 0 1 2 2v3" />
      <path d="M20 15v3a2 2 0 0 1-2 2h-3" />
      <path d="M9 20H6a2 2 0 0 1-2-2v-3" />
      <path d="M9 10v1" />
      <path d="M15 10v1" />
      <path d="M12 10v3" />
      <path d="M9.5 16a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}
