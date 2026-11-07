import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileReport, UiError } from "../mods/types";
import type { Shown } from "../i18n/errors";
import { useGameState } from "./useGameState";
import { useModProfiles } from "./useMods";

/**
 * A refused start. For a refusal because of mods, `seen` is the set as it was known once the
 * launcher tried to read it again: only a newer one can say the refusal no longer holds.
 */
export interface LaunchError {
  tag: string;
  error: UiError;
  shown: Shown;
  seen?: ProfileReport;
  /** The read again failed: the blocker panel can't say which mods, so this notice does. */
  unread?: Shown;
}

/** What a page shows of a refused start of `tag`. */
export interface Refusal {
  /** A refusal for any other reason: shown as it is. */
  shownError: Shown | null;
  /** The mod whose stored copy is gone (`ModStoreMissing`): installing it again is the fix. */
  storeMissing: string | null;
  /** A refusal because of mods that couldn't be read again: shown with "Check mods again". */
  unread: LaunchError | null;
  /** The last start was refused because of mods, and that still holds. */
  refusedForMods: boolean;
}

/**
 * Starting a version, wherever Play is: Home and Versions start the same way and handle a
 * refusal the same way. A refusal because of mods the shown set doesn't have (a revocation Play
 * applied, a change from elsewhere) reads the set again, so the blocker panel can say what and
 * offer the fixes; once a newer read of the set has nothing blocking, the refusal goes.
 */
export function useLaunch() {
  const { launch } = useGameState();
  const { profile, readProfile } = useModProfiles();
  const [launchError, setLaunchError] = useState<LaunchError | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [rereading, setRereading] = useState(false);
  const going = useRef(false);

  /** Reads a refused version's set again; the refusal then holds until a newer set clears it. */
  const reread = useCallback(
    async (refusal: LaunchError): Promise<LaunchError> => {
      setRereading(true);
      // Play found something the shown set doesn't have: only a read from after it says what.
      const r = await readProfile(refusal.tag, true);
      setRereading(false);
      if ("report" in r) return { ...refusal, seen: r.report, unread: undefined };
      return { ...refusal, seen: profile(refusal.tag), unread: r.error };
    },
    [readProfile, profile]
  );

  /** Starts `tag`; a press while a start is being checked is not sent again. */
  const start = useCallback(
    async (tag: string) => {
      if (going.current) return;
      going.current = true;
      setLaunching(tag);
      setLaunchError(null);
      try {
        const r = await launch(tag);
        if (r.status !== "failed") return;
        const refusal: LaunchError = { tag, error: r.error, shown: r.shown };
        // If the read fails, the refusal stays on screen, with a way to read it again.
        setLaunchError(r.error.code === "ModsBlocked" ? await reread(refusal) : refusal);
      } finally {
        going.current = false;
        setLaunching(null);
      }
    },
    [launch, reread]
  );

  const checkAgain = useCallback(async () => {
    if (launchError) setLaunchError(await reread(launchError));
  }, [launchError, reread]);

  // A refusal because mods blocked is about that set: once a report of it newer than the one
  // known at the refusal has nothing blocking (the player fixed it, on any page), the refusal no
  // longer holds. An older report, or none, never clears it.
  const report = profile(launchError?.tag);
  const reportBlocks = (report?.blocking.length ?? 0) > 0;
  useEffect(() => {
    if (launchError?.error.code !== "ModsBlocked" || !report || report === launchError.seen) return;
    if (!reportBlocks) setLaunchError(null);
    // A read that succeeds after a failed one: the panel takes over.
    else if (launchError.unread) setLaunchError({ ...launchError, seen: report, unread: undefined });
  }, [launchError, report, reportBlocks]);

  /** What to show about `tag`'s last refused start, if there is one. */
  const refusalFor = useCallback(
    (tag: string | null): Refusal => {
      const refusal = tag && launchError?.tag === tag ? launchError : null;
      if (!refusal) return { shownError: null, unread: null, refusedForMods: false, storeMissing: null };
      if (refusal.error.code !== "ModsBlocked") {
        const storeMissing = refusal.error.code === "ModStoreMissing" ? refusal.error.detail : null;
        return { shownError: refusal.shown, unread: null, refusedForMods: false, storeMissing };
      }
      // Said by the blocker panel, with its fixes, unless the set couldn't be read or shows nothing.
      const blocks = (profile(tag)?.blocking.length ?? 0) > 0;
      return { shownError: null, unread: refusal.unread || !blocks ? refusal : null, refusedForMods: true, storeMissing: null };
    },
    [launchError, profile]
  );

  /** Shows an error of another action next to Play, e.g. a folder that wouldn't open. */
  const fail = useCallback((tag: string, error: UiError, shown: Shown) => setLaunchError({ tag, error, shown }), []);
  const clear = useCallback(() => setLaunchError(null), []);

  return { start, launching, rereading, checkAgain, refusalFor, fail, clear };
}

export type Launch = ReturnType<typeof useLaunch>;
