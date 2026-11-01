import { useEffect, useRef, useState } from "react";

interface Option {
  value: string;
  label: string;
}

interface VersionSelectProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled: boolean;
  label: string;
}

// Not a native <select>: its popup is drawn by the system and can't take the launcher's look.
export function VersionSelect({ value, options, onChange, disabled, label }: VersionSelectProps) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const show = () => {
    setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (next: string) => {
    setOpen(false);
    onChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(options.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(options[cursor].value);
    }
  };

  return (
    <div className="version-select" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="version-select-btn"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span>{current?.label ?? ""}</span>
        <svg width="16" height="8" viewBox="0 0 8 4" fill="currentColor" aria-hidden="true">
          <path d="M0 0h8v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1z" />
        </svg>
      </button>
      {open && (
        <ul className="version-select-menu" role="listbox" aria-label={label}>
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                tabIndex={-1}
                className={`version-select-item${o.value === value ? " active" : ""}${i === cursor ? " cursor" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(o.value)}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
