/**
 * An icon drawn as rows of `#`. `scale` is one pixel's size on screen: 2 px matches 16 px text, and
 * each further step of 8 px of font size adds one.
 */
export function PixelIcon({ rows, scale = 2 }: { rows: string[]; scale?: number }) {
  return (
    <svg
      className="pixel-icon"
      width={rows[0].length * scale}
      height={rows.length * scale}
      viewBox={`0 0 ${rows[0].length} ${rows.length}`}
      fill="currentColor"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) =>
        [...row].map((c, x) => (c === "#" ? <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" /> : null))
      )}
    </svg>
  );
}
