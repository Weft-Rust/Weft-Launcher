import { t, type MessageKey } from './index';
import type { AppErrorPayload, ErrorCode } from '../mods/types';

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
};

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && code in ERROR_KEY;
}

export function errorKey(code: ErrorCode): MessageKey {
  return ERROR_KEY[code];
}

export function translateError(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const { code, detail } = err as Partial<AppErrorPayload> & { code?: unknown };
    if (isErrorCode(code)) return t(ERROR_KEY[code], typeof detail === 'string' ? detail : '');
    // A code this build doesn't know yet: say what there is rather than nothing.
    if (typeof code === 'string') return typeof detail === 'string' && detail ? `${code}: ${detail}` : code;
  }
  return String(err);
}
