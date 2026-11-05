import { formatTime, t, type MessageKey } from './index';
import type { ErrorCode, UiError } from '../mods/types';

// Every code the backend can send, and the message for it. A Record over the closed union, so a
// new code fails `tsc` until it has a message; `npm run check:i18n` checks every locale has it.
export const ERROR_KEY: Record<ErrorCode, MessageKey> = {
  Network: 'errors.network',
  HttpStatus: 'errors.httpStatus',
  Io: 'errors.io',
  Serde: 'errors.serialization',
  InvalidHeader: 'errors.httpHeader',
  CacheCorrupted: 'errors.cacheCorrupted',
  RateLimited: 'errors.rateLimited',
  Forbidden: 'errors.forbidden',
  OfflineNoCache: 'errors.offlineNoCache',
  DiskFull: 'errors.diskFull',
  AssetNotFound: 'errors.assetNotFound',
  MissingDigest: 'errors.missingDigest',
  Zip: 'errors.zip',
  CreateDir: 'errors.createDir',
  Sha256Mismatch: 'errors.sha256Mismatch',
  HashMissing: 'errors.hashMissing',
  AlreadyInstalled: 'errors.alreadyInstalled',
  NotInstalled: 'errors.notInstalled',
  DownloadFailed: 'errors.downloadFailed',
  ExtractFailed: 'errors.extractFailed',
  GameRunning: 'errors.gameRunning',
  VersionInUse: 'errors.versionInUse',
  InvalidName: 'errors.invalidName',
  InstallInProgress: 'errors.installInProgress',
  AlreadyRunning: 'errors.alreadyRunning',
  AnotherGameRunning: 'errors.anotherGameRunning',
  ExecutableNotFound: 'errors.executableNotFound',
  ProcessSpawnFailed: 'errors.processSpawnFailed',
  LogDirCreateFailed: 'errors.logDirCreateFailed',
  GameFolderNotFound: 'errors.gameFolderNotFound',
  OpenerError: 'errors.openerError',
  IndexSignatureInvalid: 'errors.indexSignatureInvalid',
  IndexRollback: 'errors.indexRollback',
  IndexInvalid: 'errors.indexInvalid',
  AbiUnavailable: 'errors.abiUnavailable',
  ModNotInCatalog: 'errors.modNotInCatalog',
  ModIncompatible: 'errors.modIncompatible',
  ModNotForPlatform: 'errors.modNotForPlatform',
  ModRevoked: 'errors.modRevoked',
  ModArchiveInvalid: 'errors.modArchiveInvalid',
  ModFileChanged: 'errors.modFileChanged',
  ModNotInstalled: 'errors.modNotInstalled',
  ModsBlocked: 'errors.modsBlocked',
  ModSourceInvalid: 'errors.modSourceInvalid',
  ModSourceNotFound: 'errors.modSourceNotFound',
  ModSourcesDamaged: 'errors.modSourcesDamaged',
  ModSourceRateLimited: 'errors.modSourceRateLimited',
  ModDownloadNotFound: 'errors.modDownloadNotFound',
  ModTooLarge: 'errors.modTooLarge',
  ModIdReserved: 'errors.modIdReserved',
  ModChangedMeanwhile: 'errors.modChangedMeanwhile',
  ModCancelled: 'errors.modCancelled',
  ModLockInvalid: 'errors.modLockInvalid',
  ModUrlRefused: 'errors.modUrlRefused',
  ModIconInvalid: 'errors.modIconInvalid',
};

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && code in ERROR_KEY;
}

export function errorKey(code: ErrorCode): MessageKey {
  return ERROR_KEY[code];
}

/** A failure as the player sees it: a translated sentence, and what the backend said, if anything more. */
export interface Shown {
  message: string;
  /**
   * The backend's own words (an OS error, a parser's complaint), in English. Never spliced into the
   * sentence; shown behind "Details", for the player to search for or report.
   */
  detail: string | null;
}

/**
 * A failure as a sentence. A message with a `{0}` takes the detail when the backend sends a name
 * there (a mod, a version, a repo); every other detail is kept apart, for "Details". Anything
 * this build doesn't know says so, with what there is as its detail.
 */
export function showError(err: unknown): Shown {
  if (err === null || err === undefined) return { message: '', detail: null };
  const e = asAppError(err);
  if (e.code === 'ModUrlRefused') {
    // Which rule the link broke, in words; the link itself behind Details.
    const refusal = urlRule(e.detail);
    if (refusal) return { message: t(URL_RULE_MESSAGE[refusal.kind]), detail: refusal.url || null };
  }
  if (e.code === 'ModSourceRateLimited') {
    // When GitHub said the limit ends, that is what to say: "until 14:32".
    const until = rateLimitReset(e);
    return { message: until ? t('errors.modSourceRateLimitedUntil', formatTime(until)) : t('errors.modSourceRateLimited'), detail: null };
  }
  if (e.code !== 'Unknown') {
    const key = ERROR_KEY[e.code];
    if (takesDetail(key)) return { message: t(key, e.detail ?? ''), detail: null };
    return { message: t(key), detail: e.detail };
  }
  return { message: t('errors.unknownBare'), detail: e.detail };
}

/**
 * Whatever a command rejected with. A payload with a code this build knows stays as it is;
 * anything else (a code from a newer backend, a thrown Error, a plain string) is "Unknown" with
 * what there is to say, never passed off as a known failure. In development, such a rejection is
 * logged: a Tauri plugin's or a newer backend's errors drifting from `AppErrorPayload` show up.
 */
export function asAppError(err: unknown): UiError {
  if (err && typeof err === 'object' && 'code' in err) {
    const { code, detail } = err as { code: unknown; detail?: unknown };
    const text = typeof detail === 'string' && detail.trim() ? detail : null;
    if (isErrorCode(code)) return { code, detail: text };
    if (code === 'Unknown') return { code: 'Unknown', detail: text };
    drifted(err);
    return { code: 'Unknown', detail: typeof code === 'string' ? (text ? `${code}: ${text}` : code) : text };
  }
  drifted(err);
  const detail = err instanceof Error ? err.message : err == null ? null : String(err);
  return { code: 'Unknown', detail: detail || null };
}

function drifted(err: unknown) {
  if (import.meta.env.DEV && import.meta.env.MODE !== 'test') console.warn('A rejection that is not an AppErrorPayload:', err);
}

/** The sentence alone, where there is no room for Details (a check row, a banner line). */
export function translateError(err: unknown): string {
  return showError(err).message;
}

/**
 * When GitHub said a source's rate limit ends: the backend's detail for `ModSourceRateLimited`
 * is "resets at <Unix seconds>" (src-tauri/src/mods/error.rs) when it said. Null otherwise.
 */
export function rateLimitReset(error: { code: string; detail: string | null } | null | undefined): Date | null {
  if (error?.code !== 'ModSourceRateLimited') return null;
  const m = /^resets at (\d+)$/.exec(error.detail ?? '');
  return m ? new Date(Number(m[1]) * 1000) : null;
}

/** The rules a download link can break (src-tauri/src/mods/index/format.rs `UrlProblem`), by what the player can tell from them. */
const URL_RULES: Record<string, 'host' | 'form' | 'asset'> = {
  notHttps: 'host',
  notGithub: 'host',
  backslash: 'form',
  percentEncoded: 'form',
  notAUrl: 'form',
  notCanonical: 'form',
  queryOrFragment: 'form',
  noPath: 'form',
  badRepo: 'asset',
  notReleaseAsset: 'asset',
};
const URL_RULE_MESSAGE: Record<'host' | 'form' | 'asset', MessageKey> = {
  host: 'errors.modUrlRefusedHost',
  form: 'errors.modUrlRefusedForm',
  asset: 'errors.modUrlRefusedAsset',
};

/** The rule a refused download link broke and the link, from `ModUrlRefused`'s detail ("<rule> <url>"). */
export function urlRule(detail: string | null): { kind: 'host' | 'form' | 'asset'; url: string } | null {
  const m = /^([A-Za-z]+) (.*)$/s.exec(detail ?? '');
  const kind = m ? URL_RULES[m[1]] : undefined;
  return m && kind ? { kind, url: m[2] } : null;
}

function takesDetail(key: MessageKey): boolean {
  return t(key, '\u0000').includes('\u0000');
}
