import { useEffect, useId, useRef, useState } from "react";
import { TYPE_AHEAD_MS, typeAhead } from "./typeAhead";

interface Option {
  value: string;
  label: string;
}

interface VersionSelectProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled: boolean;
  /** The accessible name, when there is no visible label to point at. */
  label?: string;
  /** The id of a visible label. */
  labelledBy?: string;
  /** One line tall, for dialogs and page headers. */
  compact?: boolean;
}

/**
 * Not a native <select>: its popup is drawn by the system and can't take the launcher's look.
 * The ARIA select-only combobox: focus stays on the trigger, which is a `combobox` that controls
 * the `listbox`; `aria-activedescendant` (valid on a combobox) names the option the arrow keys are
 * on, and that option is the one with `aria-selected`, as the pattern has it. The chosen value
 * is the trigger's text, and is marked in the list by its look only.
 */
export function VersionSelect({ value, options, onChange, disabled, label, labelledBy, compact = false }: VersionSelectProps) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  /** What has been typed since the last pause, for type-ahead. */
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

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

  useEffect(() => {
    if (open) document.getElementById(optionId(cursor))?.scrollIntoView({ block: "nearest" });
    // optionId depends only on listId, which never changes.
  }, [open, cursor]);

  const show = () => {
    setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  /** A printable key: moves to the next version that starts with what was typed, opening the list. */
  const typeKey = (key: string, from: number) => {
    const now = Date.now();
    const text = (now - typed.current.at > TYPE_AHEAD_MS ? "" : typed.current.text) + key;
    typed.current = { text, at: now };
    const i = typeAhead(
      options.map((o) => o.label),
      text,
      from
    );
    if (i >= 0) setCursor(i);
    if (!open) setOpen(true);
  };
  const printable = (e: React.KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  const typing = () => Date.now() - typed.current.at <= TYPE_AHEAD_MS && typed.current.text !== "";

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A space while typing is part of the word; otherwise it chooses, as Enter does.
    if (printable(e) && (e.key !== " " || typing())) {
      e.preventDefault();
      typeKey(e.key, open ? cursor : Math.max(0, options.findIndex((o) => o.value === value)));
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      // Closes the list, not the dialog around it: Dialog skips Escape on an open popup.
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(options.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(options[cursor].value);
    }
  };

  return (
    <div className={`version-select${compact ? " compact" : ""}`} ref={root}>
      <button
        type="button"
        role="combobox"
        className="version-select-btn"
        disabled={disabled}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(cursor) : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span>{current?.label ?? ""}</span>
        <svg width="16" height="8" viewBox="0 0 8 4" fill="currentColor" aria-hidden="true">
          <path d="M0 0h8v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1z" />
        </svg>
      </button>
      <ul
        className="version-select-menu"
        role="listbox"
        id={listId}
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        hidden={!open}
      >
        {open &&
          options.map((o, i) => (
            <li
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === cursor}
              className={`version-select-item${o.value === value ? " active" : ""}${i === cursor ? " cursor" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o.value)}
            >
              {o.label}
            </li>
          ))}
      </ul>
    </div>
  );
}
