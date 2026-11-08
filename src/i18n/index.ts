export type Locale = 'pt-BR' | 'en' | 'es' | 'ru';

interface I18nMessages {
  updateAvailable: string;
updateDownloading: string;
updateFailed: string;
updateTooltip: string;
updateCloseGame: string;
  latestBadge: string;
  appTitle: string;
  refreshButton: string;
  loading: string;
  cacheBanner: string;
  errorPrefix: string;
  emptyState: string;
  installButton: string;
  installedBadge: string;
  deleteButton: string;
  deleteForReal: string;
  confirmDelete: string;
  playButton: string;
  playing: string;
  progressDownloading: string;
  progressVerifying: string;
  progressExtracting: string;
  progressFinalizing: string;
  deleteDisabledTooltip: string;
  playDisabledTooltip: string;
  installedAtLabel: string;
  linkDiscord: string;
  linkWebsite: string;
  releasedLabel: string;
  inUseBadge: string;
  noChangelog: string;
  newBadge: string;
  openFolderButton: string;
  gameClosedError: string;
  openLogButton: string;
  tabHome: string;
  tabVersions: string;
  tabNotes: string;
  tabsLabel: string;
  selectVersionLabel: string;
  selectVersionHint: string;
  noVersionsInstalled: string;
  goToVersionsTab: string;
  instanceCardTitle: string;
  versionLabel: string;
  gameFolderTitle: string;
  prereleaseBadge: string;
  heroBadge: string;
  heroBadgePlaying: string;
  tabMods: string;
  modsInstalled: string;
  modsNoneInstalled: string;
  modsNoneAvailable: string;
  modsUnsupported: string;
  modVerified: string;
  modUnverified: string;
  modOn: string;
  modOff: string;
  modUpdate: string;
  modSource: string;
  modsShowUnverified: string;
  modsHideUnverified: string;
  modsUnverifiedNote: string;
  modBuiltAgain: string;
  modsBrowse: string;
  modFromFile: string;
  modDescription: string;
  modBy: string;
  modClose: string;
  modCancel: string;
  modInstallTitle: string;
  modUpdateTitle: string;
  modInstallFile: string;
  modWarnVerified: string;
  modWarnUnverified: string;
  modWarnFile: string;
  modAlsoInstalls: string;
  modReplaces: string;
  modInstallAnyway: string;
  errors: {
    network: string;
    io: string;
    serialization: string;
    httpHeader: string;
    cacheCorrupted: string;
    assetNotFound: string;
    missingDigest: string;
    rateLimited: string;
    forbidden: string;
    offlineNoCache: string;
    zip: string;
    createDir: string;
    sha256Mismatch: string;
    hashMissing: string;
    alreadyInstalled: string;
    notInstalled: string;
    downloadFailed: string;
    extractFailed: string;
    gameRunning: string;
    versionInUse: string;
    alreadyRunning: string;
    anotherGameRunning: string;
    executableNotFound: string;
    processSpawnFailed: string;
    logDirCreateFailed: string;
    gameFolderNotFound: string;
    unsupportedPlatform: string;
    openerError: string;
    invalidName: string;
    installInProgress: string;
    modsUnsupported: string;
    noBuild: string;
    notAMod: string;
  };
  sizeUnits: {
    B: string;
    KB: string;
    MB: string;
    GB: string;
  };
}

import ptBR from './pt-BR.json';
import en from './en.json';
import es from './es.json';
import ru from './ru.json';

const messagesMap: Record<Locale, I18nMessages> = {
  'pt-BR': ptBR,
  en,
  es,
  ru,
};

let currentLocale: Locale = 'en';
let messages: I18nMessages = messagesMap.en;

export function initI18n(locale?: Locale): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('locale');
  } catch {
    saved = null;
  }
  const candidate = (locale || saved) as Locale | null;
  currentLocale = candidate && candidate in messagesMap ? candidate : 'en';
  messages = messagesMap[currentLocale];
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try {
    localStorage.setItem('locale', locale);
  } catch {
    /* ignora */
  }
  messages = messagesMap[locale];
}

export function t(key: string, ...args: string[]): string {
  if (!messages) {
    return key;
  }
  
  const keys = key.split('.');
  let value: any = messages;
  
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return key;
    }
  }
  
  if (typeof value === 'string') {
    return args.reduce((str, arg, i) => str.replace(`{${i}}`, arg), value);
  }
  
  return key;
}

export function formatSize(bytes: number): string {
  if (!messages) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
  
  const units = [messages.sizeUnits.B, messages.sizeUnits.KB, messages.sizeUnits.MB, messages.sizeUnits.GB];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}