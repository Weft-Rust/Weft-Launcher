import { useCallback, useRef } from "react";
import { modsApi } from "../mods/api";
import { ProfileReads } from "../mods/profileReads";
import type { ProfileReport } from "../mods/types";

/**
 * Profile answers per version, in order (mods/profileReads): a slow read can't undo a change,
 * reads share, and a fresh read is never served by one that began before it was asked.
 */
export function useProfileCoordinator(setProfiles: (fn: (p: Record<string, ProfileReport>) => Record<string, ProfileReport>) => void) {
  const set = useRef(setProfiles);
  set.current = setProfiles;
  const reads = useRef<ProfileReads | null>(null);
  reads.current ??= new ProfileReads(
    (tag) => modsApi.profile(tag),
    (tag, report) => set.current((p) => ({ ...p, [tag]: report }))
  );

  /** One read per version at a time; with `fresh`, one that began after this call. */
  const read = useCallback((tag: string, fresh = false) => reads.current!.read(tag, fresh), []);
  /** A change's report is the newest state when it arrives. */
  const changed = useCallback((tag: string, report: ProfileReport) => reads.current!.changed(tag, report), []);

  return { read, changed };
}
