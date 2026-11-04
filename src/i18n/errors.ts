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
  ModSourceRateLimited: 'errors.modSourceRateLimited',
  ModDownloadNotFound: 'errors.modDownloadNotFound',
  ModTooLarge: 'errors.modTooLarge',
  ModIdReserved: 'errors.modIdReserved',
  ModChangedMeanwhile: 'errors.modChangedMeanwhile',
};

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && code in ERROR_KEY;
}

export function errorKey(code: ErrorCode): MessageKey {
  return ERROR_KEY[code];
}

/**
 * A failure as a sentence. A known code gets its message; anything else (an "Unknown" from
 * asAppError, a code this build doesn't know, a thrown Error) says so and keeps what detail there
 * is, rather than passing for a known failure.
 */
export function translateError(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'object' && !(err instanceof Error)) {
    const { code, detail } = err as { code?: unknown; detail?: unknown };
    const text = typeof detail === 'string' ? detail : '';
    if (isErrorCode(code)) return t(ERROR_KEY[code], text);
    if (typeof code === 'string' && code !== 'Unknown') return t('errors.unknown', text ? `${code}: ${text}` : code);
    return text ? t('errors.unknown', text) : t('errors.unknownBare');
  }
  const text = err instanceof Error ? err.message : String(err);
  return text ? t('errors.unknown', text) : t('errors.unknownBare');
}
