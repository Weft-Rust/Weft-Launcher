// Reads of a version's mod set, in order, without React: hooks/useProfileCoordinator holds one.

import type { ProfileReport } from "./types";

interface Running {
  promise: Promise<ProfileReport>;
  /** The freshness epoch the read began in; null while it waits for an older read to end. */
  began: number | null;
}

/**
 * Profile answers per version, in order, and fresh when asked to be.
 *
 * - Every read and every finished change takes a ticket; an answer older than one already shown
 *   is dropped, so a slow read can't undo a change.
 * - Reads share: a caller during a read gets that read, not a second one.
 * - A fresh read (after the catalogue or the set changed: a refresh brought revocations, Play was
 *   refused) never shares a read that began before it was asked. It waits for that one to end and
 *   reads again, so its answer is from after the change. Fresh reads asked while that second read
 *   hasn't begun share it.
 */
export class ProfileReads {
  private issued: Record<string, number> = {};
  private shown: Record<string, number> = {};
  private epoch: Record<string, number> = {};
  private running: Record<string, Running> = {};

  constructor(
    private fetch: (tag: string) => Promise<ProfileReport>,
    private show: (tag: string, report: ProfileReport) => void
  ) {}

  private ticket(tag: string): number {
    return (this.issued[tag] = (this.issued[tag] ?? 0) + 1);
  }

  private offer(tag: string, at: number, report: ProfileReport) {
    if (at <= (this.shown[tag] ?? 0)) return;
    this.shown[tag] = at;
    this.show(tag, report);
  }

  /** Starts a read now, in the current epoch. */
  private begin(tag: string): Promise<ProfileReport> {
    const at = this.ticket(tag);
    const entry: Running = { promise: Promise.resolve(null as unknown as ProfileReport), began: this.epoch[tag] ?? 0 };
    entry.promise = this.fetch(tag)
      .then((report) => {
        this.offer(tag, at, report);
        return report;
      })
      .finally(() => {
        if (this.running[tag] === entry) delete this.running[tag];
      });
    this.running[tag] = entry;
    return entry.promise;
  }

  /** The set of `tag`; with `fresh`, read after anything that began before this call. */
  read(tag: string, fresh = false): Promise<ProfileReport> {
    if (fresh) this.epoch[tag] = (this.epoch[tag] ?? 0) + 1;
    const now = this.epoch[tag] ?? 0;
    const running = this.running[tag];
    if (!running) return this.begin(tag);
    // Waiting to begin, or begun in this epoch: fresh enough to share.
    if (running.began === null || running.began >= now) return running.promise;
    // Begun before a change this read must see: read again once it ends.
    const queued: Running = { promise: Promise.resolve(null as unknown as ProfileReport), began: null };
    queued.promise = running.promise
      .catch(() => undefined)
      .then(() => {
        if (this.running[tag] === queued) delete this.running[tag];
        return this.begin(tag);
      });
    this.running[tag] = queued;
    return queued.promise;
  }

  /** A change's report is the newest state when it arrives: its ticket is taken then. */
  changed(tag: string, report: ProfileReport) {
    this.offer(tag, this.ticket(tag), report);
  }
}
