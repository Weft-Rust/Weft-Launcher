import { useCallback, useEffect, useRef, useState } from "react";
import { showError, type Shown } from "../i18n/errors";

/**
 * One request for a dialog's plan (an install plan, a copy preview, a file inspection), keyed
 * by everything the answer depends on.
 *
 * - `key` names the request: the version, the build or file, the source version. A new key
 *   drops what was shown: it was about something else.
 * - `inputs` are what the answer was computed from (the version's set, the catalogue), compared
 *   by content: a reload that brings the same set or catalogue asks nothing again. When one of
 *   them does change, it asks again.
 * - While it asks again, the plan on screen stays usable: the backend checks the token of the
 *   plan the player agreed to when they press the button, and refuses one that changed
 *   (`ModChangedMeanwhile`). An answer with the same token keeps the plan on screen as it is, so
 *   the button never flickers; one with another token replaces it.
 *
 * `ready` is false only before the first answer for this key, after `reload` until its answer
 * comes, and on an error: a late answer to an older key can never enable a button. Every dialog
 * that asks the player to agree to a plan guards its button with it.
 */
export interface PlanRequest<T> {
  /** The answer on screen; null before the first one for this key. */
  value: T | null;
  /** The answer on screen is for this key, and can be agreed to. */
  ready: boolean;
  error: Shown | null;
  /** Asks again for the same key, e.g. after the backend refused a plan as out of date. */
  reload: () => void;
}

type Answer<T> = { key: string; revision: number; nonce: number; value: T | null; error: Shown | null };

export function usePlan<T extends { planToken: string }>(
  key: string | null,
  inputs: readonly unknown[],
  load: (() => Promise<T>) | null
): PlanRequest<T> {
  const revision = useRevision(inputs);
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    const run = loader.current;
    if (key === null || !run) return;
    let live = true;
    run()
      .then((value) => {
        if (!live) return;
        setAnswer((prev) =>
          // The same plan again: the one on screen stays, object and all.
          prev && prev.key === key && prev.value && prev.value.planToken === value.planToken
            ? { ...prev, revision, nonce, error: null }
            : { key, revision, nonce, value, error: null }
        );
      })
      .catch((err) => live && setAnswer({ key, revision, nonce, value: null, error: showError(err) }));
    return () => {
      live = false;
    };
  }, [key, revision, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const sameKey = answer !== null && answer.key === key;
  // After `reload`, the plan on screen is the one the backend refused: it waits for the new one.
  const current = sameKey && answer.nonce === nonce;
  return {
    value: sameKey ? answer.value : null,
    ready: current && answer.value !== null && answer.error === null,
    error: current ? answer.error : null,
    reload,
  };
}

const keys = new WeakMap<object, string>();

/** What an input is, by content: the same set read twice is the same input. */
export function contentKey(x: unknown): string {
  if (x === null || typeof x !== "object") return `${typeof x}:${String(x)}`;
  let k = keys.get(x);
  if (k === undefined) {
    k = JSON.stringify(x);
    keys.set(x, k);
  }
  return k;
}

/** A number that goes up whenever one of `inputs` changes content. */
function useRevision(inputs: readonly unknown[]): number {
  const now = inputs.map(contentKey);
  const last = useRef<{ keys: string[]; n: number }>({ keys: now, n: 0 });
  const same = last.current.keys.length === now.length && now.every((k, i) => k === last.current.keys[i]);
  if (!same) last.current = { keys: now, n: last.current.n + 1 };
  return last.current.n;
}
