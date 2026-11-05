import { useCallback, useEffect, useRef, useState } from "react";
import { asAppError, listenTo, modsApi } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import type { Catalog, UiError } from "../mods/types";
import { failed, type ActionResult } from "./result";

export interface CatalogState {
  catalog: Catalog | null;
  /** The newest refresh is still running. */
  catalogLoading: boolean;
  /** Why the newest finished refresh failed; kept until one succeeds, also while an older catalogue shows. */
  catalogError: UiError | null;
  refreshCatalog: () => Promise<void>;
  /** Asks one source again; the others keep their answers and nothing waits on them. */
  refreshSource: (repo: string) => Promise<UiError | null>;
  /** The sources being asked again: on their own, or still by a whole refresh whose index is in. */
  sourceRefreshing: (repo: string) => boolean;
  /** The sources a whole refresh still waits on, while what else it brought already shows. */
  pendingSources: string[];

  /** The player's list of sources, once read; null before, or when it couldn't be. */
  sourceList: string[] | null;
  /** Why the list couldn't be read (`ModSourcesDamaged`: it was kept aside). */
  sourceListError: UiError | null;
  loadSources: () => Promise<void>;
  /** Adds a source; one change to the list at a time ("skipped" while another runs). */
  addSource: (repo: string) => Promise<ActionResult<string[]>>;
  removeSource: (repo: string) => Promise<ActionResult<string[]>>;
  /** The change to the list that is running. */
  sourceChange: { kind: "add" | "remove"; repo: string } | null;
}

/**
 * The catalogue, kept in order. Answers can arrive in any order (a slow refresh finishing after
 * a quick one); each carries the backend's revision, and only a higher one replaces what shows.
 * Errors and the loading state belong to the newest request only: an older one failing late
 * neither shows its error over a newer success nor ends the newer one's loading.
 *
 * `afterRefresh` runs once a refresh is done: revocations and updates come with the catalogue,
 * so every version's set is read again then.
 */
export function useCatalog(afterRefresh: () => Promise<unknown>): CatalogState {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<UiError | null>(null);
  const [refreshing, setRefreshing] = useState<Record<string, number>>({});
  const issued = useRef(0);
  /** The newest request that has answered, either way. */
  const settled = useRef(0);
  const after = useRef(afterRefresh);
  after.current = afterRefresh;
  /** The sources a whole refresh still waits on, by its early parts (`mod-catalog`). */
  const [pending, setPending] = useState<string[]>([]);

  /** Shows `next` unless what shows is newer. */
  const offer = useCallback((next: Catalog) => {
    setCatalog((shown) => (shown && shown.revision > next.revision ? shown : next));
  }, []);

  const refreshCatalog = useCallback(async () => {
    const id = ++issued.current;
    setCatalogLoading(true);
    try {
      const next = await modsApi.catalog(true);
      offer(next);
      if (id > settled.current) {
        settled.current = id;
        setCatalogError(null);
      }
    } catch (err) {
      // The catalogue shown so far stays; the banner says it couldn't be refreshed, and why,
      // unless a newer request has answered meanwhile.
      if (id > settled.current) {
        settled.current = id;
        setCatalogError(asAppError(err));
      }
    } finally {
      if (id === issued.current) {
        setCatalogLoading(false);
        setPending([]);
      }
    }
    await after.current();
  }, [offer]);

  // A refresh's early parts: the index as soon as it verifies, then each source. Shown at once,
  // and every set read again, since revocations come with the index: a slow source doesn't hold
  // them back. The command's own answer comes last and is the whole refresh.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listenTo(EVENTS.modCatalog, (e) => {
      offer(e.payload.catalog);
      setPending(e.payload.pending);
      void after.current();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [offer]);

  const refreshSource = useCallback(
    async (repo: string) => {
      setRefreshing((r) => ({ ...r, [repo]: (r[repo] ?? 0) + 1 }));
      try {
        offer(await modsApi.refreshSource(repo));
        return null;
      } catch (err) {
        return asAppError(err);
      } finally {
        setRefreshing((r) => {
          const left = (r[repo] ?? 1) - 1;
          const { [repo]: _, ...rest } = r;
          return left > 0 ? { ...r, [repo]: left } : rest;
        });
        await after.current();
      }
    },
    [offer]
  );

  const sourceRefreshing = useCallback(
    (repo: string) => !!refreshing[repo] || pending.some((r) => r.toLowerCase() === repo.toLowerCase()),
    [refreshing, pending]
  );

  // The cache shows something at once, then the network says what is new.
  useEffect(() => {
    modsApi
      .catalog(false)
      .then(offer)
      .catch(() => {})
      .finally(() => refreshCatalog());
  }, [offer, refreshCatalog]);

  // The list of sources: read, added to and taken from here, one change at a time, so the
  // dialog that shows it only renders.
  const [sourceList, setSourceList] = useState<string[] | null>(null);
  const [sourceListError, setSourceListError] = useState<UiError | null>(null);
  const [sourceChange, setSourceChange] = useState<CatalogState["sourceChange"]>(null);
  const changing = useRef(false);
  const loadSources = useCallback(async () => {
    setSourceListError(null);
    try {
      setSourceList(await modsApi.sources());
    } catch (err) {
      setSourceListError(asAppError(err));
    }
  }, []);
  const changeSources = useCallback(async (kind: "add" | "remove", repo: string): Promise<ActionResult<string[]>> => {
    if (changing.current) return { status: "skipped" };
    changing.current = true;
    setSourceChange({ kind, repo });
    try {
      const list = await (kind === "add" ? modsApi.addSource(repo) : modsApi.removeSource(repo));
      setSourceList(list);
      setSourceListError(null);
      return { status: "done", result: list };
    } catch (err) {
      return failed(err);
    } finally {
      changing.current = false;
      setSourceChange(null);
    }
  }, []);
  const addSource = useCallback((repo: string) => changeSources("add", repo), [changeSources]);
  const removeSource = useCallback((repo: string) => changeSources("remove", repo), [changeSources]);

  return {
    catalog,
    catalogLoading,
    catalogError,
    refreshCatalog,
    refreshSource,
    sourceRefreshing,
    pendingSources: pending,
    sourceList,
    sourceListError,
    loadSources,
    addSource,
    removeSource,
    sourceChange,
  };
}
