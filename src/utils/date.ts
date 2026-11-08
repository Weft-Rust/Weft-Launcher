// By hand, not toLocaleString: the order of day and month has to follow the launcher's language,
// whatever the system's or the webview's own locale data say.
const ORDER: Record<string, { sep: string; monthFirst: boolean }> = {
  en: { sep: "/", monthFirst: true },
  ru: { sep: ".", monthFirst: false },
  es: { sep: "/", monthFirst: false },
  "pt-BR": { sep: "/", monthFirst: false },
};

const two = (n: number) => String(n).padStart(2, "0");

export function formatDate(dateString: string, locale: string, withTime = false): string {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return "";
  const { sep, monthFirst } = ORDER[locale] ?? ORDER.en;
  const [day, month] = [two(d.getDate()), two(d.getMonth() + 1)];
  const date = (monthFirst ? [month, day] : [day, month]).concat(String(d.getFullYear())).join(sep);
  return withTime ? `${date} ${two(d.getHours())}:${two(d.getMinutes())}` : date;
}
