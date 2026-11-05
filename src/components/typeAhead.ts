/**
 * Type-ahead for a list of labels, as the ARIA listbox pattern has it: the typed letters pick the
 * next label that starts with them, from the one after `from` and round again. A version's
 * leading "v" can be left out ("26.10" finds "v26.10.4"). Typing one key again and again steps
 * through the labels that start with it. -1 when nothing matches.
 */
export function typeAhead(labels: string[], typed: string, from: number): number {
  const want = typed.toLowerCase();
  if (!want) return -1;
  const repeated = [...want].every((c) => c === want[0]);
  const prefix = repeated ? want[0] : want;
  const fits = (label: string) => {
    const l = label.toLowerCase();
    return l.startsWith(prefix) || l.replace(/^v(?=\d)/, "").startsWith(prefix);
  };
  // A longer word goes on matching the label it is on; one key repeated moves on.
  const start = repeated ? from + 1 : from;
  for (let k = 0; k < labels.length; k++) {
    const i = (((start + k) % labels.length) + labels.length) % labels.length;
    if (fits(labels[i])) return i;
  }
  return -1;
}

/** How long a pause ends a typed word. */
export const TYPE_AHEAD_MS = 600;
