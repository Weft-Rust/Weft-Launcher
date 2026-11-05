import { useCallback, useEffect, useRef, useState } from "react";
import { showError, type Shown } from "../i18n/errors";

/**
 * One request for a dialog's plan (an install plan, a copy preview, a file inspection), keyed
 * by everything the answer depends on.
 *
 * - `key` names the request: the version, the build or file, the source version. A new key
 *   drops what was shown: it was about something else.
 * - `inputs` are what the answer was computed from (the version's set, the catalogue). When one
 *   of them changes, it asks again; the last answer stays on screen meanwhile, marked stale.
 *
 * `ready` is true only while the answer on screen is the answer to this exact key and revision,
 * so a late answer to an older request can never enable a button. Every dialog that asks the
 * player to agree to a plan guards its button with it.
 */
export interface PlanRequest<T> {
  /** The answer on screen, current or stale; null before the first one for this key. */
  value: T | null;
  /** The answer on screen is for this key and revision. */
  ready: boolean;
  error: Shown | null;
  /** Asks again for the same key, e.g. after the backend refused a plan as out of date. */
  reload: () => void;
}

type Answer<T> = { key: string; revision: number; nonce: number; value: T | null; error: Shown | null };

export function usePlan<T>(key: string | null, inputs: readonly unknown[], load: (() => Promise<T>) | null): PlanRequest<T> {
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
      .then((value) => live && setAnswer({ key, revision, nonce, value, error: null }))
      .catch((err) => live && setAnswer({ key, revision, nonce, value: null, error: showError(err) }));
    return () => {
      live = false;
    };
  }, [key, revision, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const sameKey = answer !== null && answer.key === key;
  return {
    value: sameKey ? answer.value : null,
    ready: sameKey && answer.revision === revision && answer.nonce === nonce && answer.value !== null,
    error: sameKey && answer.revision === revision && answer.nonce === nonce ? answer.error : null,
    reload,
  };
}

/** A number that goes up whenever one of `inputs` is no longer the same object. */
function useRevision(inputs: readonly unknown[]): number {
  const last = useRef<{ inputs: readonly unknown[]; n: number }>({ inputs, n: 0 });
  const same = last.current.inputs.length === inputs.length && inputs.every((x, i) => Object.is(x, last.current.inputs[i]));
  if (!same) last.current = { inputs, n: last.current.n + 1 };
  return last.current.n;
}
