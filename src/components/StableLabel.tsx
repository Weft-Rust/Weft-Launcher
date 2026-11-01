/**
 * A button label that keeps the width of its longest text, so changing the text (Delete to
 * "Delete for real") never moves or resizes anything around it.
 */
export function StableLabel({ text, widest }: { text: string; widest: string[] }) {
  return (
    <span className="stable-label">
      {widest.map((w) => (
        <span key={w} className="stable-label-spacer" aria-hidden="true">{w}</span>
      ))}
      <span>{text}</span>
    </span>
  );
}
