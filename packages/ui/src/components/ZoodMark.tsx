import { useId } from 'react';
import './zoodMark.css';

/**
 * ZOOD's own mark (website/assets/brand/mark.svg: the brand's five strokes,
 * the paths exactly as its identity package draws them), in bronze. With
 * `loop`, the strokes rise in one after another and a sheen crosses them,
 * again every few seconds; Reduce Motion leaves it still. Purely
 * decorative: whatever sits beside it names the app.
 */

const STROKES = [
  'M452.273 0.000C410.297 66.543 336.143 110.755 251.653 110.755C167.163 110.755 93.009 66.543 51.033 0.000L0.001 0.000C42.641 84.209 129.992 141.938 230.836 141.938C331.680 141.938 419.031 84.209 461.672 0.000Z',
  'M264.142 75.455C323.786 75.455 376.445 45.587 408.008 0.001L399.096 0.001C370.144 30.605 329.155 49.703 283.701 49.703C238.247 49.703 197.258 30.605 168.306 0.001L120.276 0.001C151.839 45.587 204.498 75.455 264.142 75.455',
  'M501.465 0.465C479.730 61.055 438.122 100.783 393.590 128.746C288.770 194.568 195.134 180.586 94.473 251.297C46.166 285.232 7.892 334.769 0.000 409.514L5.764 409.049C27.499 348.459 69.107 308.732 113.639 280.768C218.460 214.946 312.095 228.929 412.756 158.217C461.063 124.283 499.337 74.745 507.229 0.000Z',
  'M292.905 328.884C225.185 328.884 164.830 360.380 125.662 409.514L137.000 409.514C171.497 374.289 219.582 352.421 272.781 352.421C325.980 352.421 374.065 374.289 408.563 409.514L460.148 409.514C420.980 360.380 360.625 328.884 292.905 328.884',
  'M272.525 268.332C172.105 268.332 83.927 325.735 41.338 409.514L87.475 409.514C128.132 338.036 204.974 289.823 293.085 289.823C381.196 289.823 458.039 338.036 498.694 409.514L507.228 409.514C464.639 325.735 372.946 268.332 272.525 268.332',
];

export function ZoodMark({ size = 64, loop = false, className }: { size?: number; loop?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const metal = `zm-metal-${id}`;
  const clip = `zm-clip-${id}`;
  const shine = `zm-shine-${id}`;
  return (
    <svg
      className={['zood-mark', loop ? 'zood-mark-loop' : '', className ?? ''].filter(Boolean).join(' ')}
      viewBox="-8 -8 523.229 425.514"
      width={size}
      height={(size * 425.514) / 523.229}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={metal} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="507" y2="409">
          <stop offset="0" stopColor="#c9a27c" />
          <stop offset="0.5" stopColor="#977756" />
          <stop offset="1" stopColor="#7a5c3f" />
        </linearGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clip}>
          {STROKES.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
      </defs>
      <g fill={`url(#${metal})`}>
        {STROKES.map((d, index) => (
          <path key={d} d={d} className="zood-mark-stroke" style={{ ['--i' as string]: index }} />
        ))}
      </g>
      {loop && (
        <g clipPath={`url(#${clip})`}>
          <rect className="zood-mark-shine" x="-260" y="-20" width="220" height="460" fill={`url(#${shine})`} />
        </g>
      )}
    </svg>
  );
}
