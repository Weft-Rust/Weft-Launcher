import { useCallback, useRef } from "react";
import { modsApi } from "../mods/api";
import type { ProfileReport } from "../mods/types";

/**
 * Profile answers per version, in order. Every read and every finished change takes a ticket;
 * an answer older than one already shown is dropped, so a slow read can't undo a change.
 */
export function useProfileCoordinator(setProfiles: (fn: (p: Record<string, ProfileReport>) => Record<string, ProfileReport>) => void) {
  const issued = useRef<Record<string, number>>({});
  const shown = useRef<Record<string, number>>({});
  const reads = useRef<Record<string, Promise<ProfileReport>>>({});

  const ticket = useCallback((tag: string) => (issued.current[tag] = (issued.current[tag] ?? 0) + 1), []);

  const offer = useCallback(
    (tag: string, at: number, report: ProfileReport) => {
      if (at <= (shown.current[tag] ?? 0)) return;
      shown.current[tag] = at;
      setProfiles((p) => ({ ...p, [tag]: report }));
    },
    [setProfiles]
  );

  /** One read per version at a time; a caller during a read shares it. */
  const read = useCallback(
    (tag: string): Promise<ProfileReport> => {
      const running = reads.current[tag];
      if (running) return running;
      const at = ticket(tag);
      const p = modsApi
        .profile(tag)
        .then((report) => {
          offer(tag, at, report);
          return report;
        })
        .finally(() => {
          delete reads.current[tag];
        });
      reads.current[tag] = p;
      return p;
    },
    [offer, ticket]
  );

  /** A change's report is the newest state when it arrives: its ticket is taken then. */
  const changed = useCallback((tag: string, report: ProfileReport) => offer(tag, ticket(tag), report), [offer, ticket]);

  return { read, changed };
}

