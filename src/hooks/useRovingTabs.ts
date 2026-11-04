import { KeyboardEvent, useCallback, useRef } from "react";

/**
 * A tablist the way the ARIA pattern has it: one tab stop, Left/Right/Home/End move and select,
 * and each tab points at its panel.
 */
export function useRovingTabs<T extends string>(prefix: string, ids: readonly T[], active: T, onChange: (id: T) => void) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      const i = ids.indexOf(active);
      const last = ids.length - 1;
      const next =
        e.key === "ArrowRight" ? (i + 1) % ids.length
        : e.key === "ArrowLeft" ? (i - 1 + ids.length) % ids.length
        : e.key === "Home" ? 0
        : e.key === "End" ? last
        : -1;
      if (next < 0) return;
      e.preventDefault();
      onChange(ids[next]);
      refs.current[ids[next]]?.focus();
    },
    [ids, active, onChange]
  );

  const tab = (id: T) => ({
    role: "tab" as const,
    id: `${prefix}-tab-${id}`,
    "aria-selected": active === id,
    "aria-controls": `${prefix}-panel-${id}`,
    tabIndex: active === id ? 0 : -1,
    ref: (el: HTMLButtonElement | null) => {
      refs.current[id] = el;
    },
    onKeyDown,
    onClick: () => onChange(id),
  });

  const panel = {
    role: "tabpanel" as const,
    id: `${prefix}-panel-${active}`,
    "aria-labelledby": `${prefix}-tab-${active}`,
  };

  return { tab, panel };
}
