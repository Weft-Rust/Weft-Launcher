import { useCallback, useEffect, useRef, useState } from "react";
import { listenTo, newOperationId } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import type { UiProgress } from "../mods/types";

/** What a running change is about, so the busy state has one owner. */
export type Operation = { kind: "mod"; tag: string; id: string } | { kind: "copy"; tag: string };

export const keyOf = (op: Operation) => (op.kind === "mod" ? `mod:${op.tag}:${op.id}` : `copy:${op.tag}`);

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

/** The first file an operation will work on, so its progress shows at once, before any event. */
export interface FirstFile {
  sha256: string;
  modId: string;
  count: number;
  /** A file already on the player's computer: its first step is checking it, not a download. */
  local?: boolean;
}

/**
 * Running operations and their progress. The client names each operation (contract R4 §3) and
 * every event carries that id, so progress always belongs to the operation that caused it; an
 * event for an operation that isn't running is dropped. When one ends, however it ends, its
 * progress goes with it.
 */
export function useOperations() {
  const [progress, setProgress] = useState<Record<string, UiProgress[]>>({});
  const [running, setRunning] = useState<Record<string, { op: Operation; operationId: string; cancelling: boolean }>>({});
  const live = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listenTo(EVENTS.modProgress, (e) => {
      const id = e.payload.operationId;
      if (![...live.current.values()].includes(id)) return;
      setProgress((p) => {
        const list = (p[id] ?? []).filter((x) => x.sha256 !== e.payload.sha256 && x.sha256 !== "");
        return { ...p, [id]: [...list, e.payload] };
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** Starts an operation and says its id, or null when the same one is already running. */
  const begin = useCallback((op: Operation, first: FirstFile | null): string | null => {
    const key = keyOf(op);
    if (live.current.has(key)) return null;
    const operationId = newOperationId();
    live.current.set(key, operationId);
    setRunning((r) => ({ ...r, [key]: { op, operationId, cancelling: false } }));
    // The first file shows at once, before its first event: getting ready, or being checked when
    // it is a file the player picked. Never "downloading" before anything is.
    const waiting: UiProgress = {
      operationId,
      sha256: first?.sha256 ?? "",
      modId: first?.modId ?? (op.kind === "mod" ? op.id : ""),
      stage: first?.local ? "verifying" : "preparing",
      percent: 0,
      index: 1,
      count: Math.max(1, first?.count ?? 1),
    };
    setProgress((p) => ({ ...p, [operationId]: [waiting] }));
    return operationId;
  }, []);

  const end = useCallback((op: Operation) => {
    const key = keyOf(op);
    const operationId = live.current.get(key);
    live.current.delete(key);
    setRunning((r) => without(r, key));
    if (operationId) setProgress((p) => without(p, operationId));
  }, []);

  const markCancelling = useCallback((op: Operation) => {
    const key = keyOf(op);
    setRunning((r) => (r[key] ? { ...r, [key]: { ...r[key], cancelling: true } } : r));
    return live.current.get(key) ?? null;
  }, []);

  return { progress, running, begin, end, markCancelling };
}

