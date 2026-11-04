import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import type { Locale } from "../i18n";

const OPTIONS: { code: Locale; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "pt-BR", label: "BR", name: "Português" },
  { code: "es", label: "ES", name: "Español" },
  { code: "ru", label: "RU", name: "Русский" },
];

/** A menu of languages: arrows move, Enter picks, Escape closes and returns to the button. */
export function LanguageMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const { locale, changeLocale } = useI18n();
  const current = OPTIONS.find((o) => o.code === locale) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    items.current[Math.max(0, OPTIONS.findIndex((o) => o.code === locale))]?.focus();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, locale]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const choose = (code: Locale) => {
    close();
    if (code !== locale) changeLocale(code);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const i = items.current.findIndex((el) => el === document.activeElement);
    const move = (n: number) => {
      e.preventDefault();
      items.current[(n + OPTIONS.length) % OPTIONS.length]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(OPTIONS.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="lang" ref={ref}>
      <button
        type="button"
        className="lang-btn"
        ref={button}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current.name} (${current.label})`}
      >
        {current.label}
      </button>
      {open && (
        <ul className="lang-menu" role="menu" aria-label={current.name} onKeyDown={onMenuKey}>
          {OPTIONS.map((o, i) => (
            <li key={o.code} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.code === locale}
                lang={o.code}
                tabIndex={-1}
                ref={(el) => {
                  items.current[i] = el;
                }}
                className={`lang-item${o.code === locale ? " active" : ""}`}
                onClick={() => choose(o.code)}
              >
                <strong aria-hidden="true">{o.label}</strong> <span>{o.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
