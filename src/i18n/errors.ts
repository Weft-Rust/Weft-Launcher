import { t, type MessageKey } from './index';
import type { ErrorCode } from '../mods/types';

// Every code the backend can send, and the message for it. A Record over the closed union, so a
// new code fails `tsc` until it has a message; `npm run check:i18n` checks every locale has it.
export const ERROR_KEY: Record<ErrorCode, MessageKey> = {
  Network: 'errors.network',
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
  if (typeof err === 'object' && !(err instanceof Error)) {
    const { code, detail } = err as { code?: unknown; detail?: unknown };
    const text = typeof detail === 'string' && detail.trim() ? detail : null;
    if (isErrorCode(code)) {
      const key = ERROR_KEY[code];
      if (takesDetail(key)) return { message: t(key, text ?? ''), detail: null };
      return { message: t(key), detail: text };
    }
    const raw = typeof code === 'string' && code !== 'Unknown' ? (text ? `${code}: ${text}` : code) : text;
    return { message: t('errors.unknownBare'), detail: raw };
  }
  const text = err instanceof Error ? err.message : String(err);
  return { message: t('errors.unknownBare'), detail: text || null };
}

/** The sentence alone, where there is no room for Details (a check row, a banner line). */
export function translateError(err: unknown): string {
  return showError(err).message;
}

function takesDetail(key: MessageKey): boolean {
  return t(key, '\u0000').includes('\u0000');
}
