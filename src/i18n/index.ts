// Messages, typed from en.json: a key that isn't there fails `tsc`. Counted messages have one key
// per CLDR plural category (`_one`, `_few`, `_many`, `_other`) and are read with `tn`.

import ptBR from './pt-BR.json';
import en from './en.json';
import es from './es.json';
import ru from './ru.json';

export type Locale = 'pt-BR' | 'en' | 'es' | 'ru';
export const LOCALES: Locale[] = ['en', 'pt-BR', 'es', 'ru'];

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

type AllKeys = Leaves<typeof en>;
type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type PluralForm<K> = K extends `${string}_${PluralCategory}` ? K : never;

/** A plain message. */
export type MessageKey = Exclude<AllKeys, PluralForm<AllKeys>>;
/** A counted message: `mods.noticeCopied` stands for `mods.noticeCopied_one`, `_other`... */
export type PluralKey = AllKeys extends infer K ? (K extends `${infer B}_other` ? B : never) : never;

/** A message to show later, for code that decides what to say but doesn't render it. */
export type Msg =
  | { key: MessageKey; args?: string[] }
  | { key: PluralKey; count: number; args?: string[] };

type Tree = { [key: string]: string | Tree };

const messagesMap: Record<Locale, Tree> = {
  'pt-BR': ptBR as Tree,
  en: en as Tree,
  es: es as Tree,
  ru: ru as Tree,
};

let currentLocale: Locale = 'en';
let messages: Tree = messagesMap.en;
let plurals = new Intl.PluralRules('en');

function use(locale: Locale) {
  currentLocale = locale;
  messages = messagesMap[locale];
  plurals = new Intl.PluralRules(locale);
}

export function isLocale(s: string | null | undefined): s is Locale {
  return !!s && (LOCALES as string[]).includes(s);
}

export function initI18n(locale?: Locale): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('locale');
  } catch {
    saved = null;
  }
  const candidate = locale ?? saved;
  use(isLocale(candidate) ? candidate : 'en');
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  use(locale);
  try {
    localStorage.setItem('locale', locale);
  } catch {
    /* ignore */
  }
}

function lookup(tree: Tree, key: string): string | null {
  let value: string | Tree | undefined = tree;
  for (const k of key.split('.')) {
    if (value && typeof value === 'object' && k in value) value = value[k];
    else return null;
  }
  return typeof value === 'string' ? value : null;
}

/** Fills `{0}`, `{1}`... and, for counted messages, `{n}`. */
export function fill(template: string, args: readonly string[], count?: string): string {
  return template.replace(/\{(\d+|n)\}/g, (whole, name: string) => {
    if (name === 'n') return count ?? whole;
    return args[Number(name)] ?? whole;
  });
}

export function t(key: MessageKey, ...args: string[]): string {
  const value = lookup(messages, key) ?? lookup(messagesMap.en, key);
  return value === null ? key : fill(value, args);
}

/** The key a count picks in a locale: `mods.noticeCopied_few` for 3 in Russian. */
export function pluralKey(key: PluralKey, count: number, locale: Locale = currentLocale): string {
  const rules = locale === currentLocale ? plurals : new Intl.PluralRules(locale);
  return `${key}_${rules.select(count)}`;
}

export function tn(key: PluralKey, count: number, ...args: string[]): string {
  const value =
    lookup(messages, pluralKey(key, count)) ??
    lookup(messages, `${key}_other`) ??
    lookup(messagesMap.en, pluralKey(key, count, 'en'));
  return value === null ? key : fill(value, args, count.toLocaleString(currentLocale));
}

export function tm(msg: Msg): string {
  const args = msg.args ?? [];
  return 'count' in msg ? tn(msg.key, msg.count, ...args) : t(msg.key, ...args);
}

/** A list of names the way the language joins them: "A, B and C". */
export function formatList(items: string[]): string {
  return new Intl.ListFormat(currentLocale, { style: 'long', type: 'conjunction' }).format(items);
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(currentLocale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  const unit = lookup(messages, `sizeUnits.${units[unitIndex]}`) ?? units[unitIndex];
  return `${size.toFixed(1)} ${unit}`;
}
