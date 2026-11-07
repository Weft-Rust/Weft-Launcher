import { createContext, useContext, useState, useCallback, useMemo, ReactNode, Fragment } from 'react';
import {
  initI18n,
  getLocale,
  setLocale,
  formatSize as i18nFormatSize,
  formatDay as i18nFormatDay,
  formatList as i18nFormatList,
  t as translate,
  tn as translatePlural,
  tm as translateMsg,
  Locale,
  MessageKey,
  PluralKey,
  Msg,
} from './index';

interface I18nContextValue {
  locale: Locale;
  t: (key: MessageKey, ...args: string[]) => string;
  /** A counted message: picks the plural form for `count` and fills `{n}`. */
  tn: (key: PluralKey, count: number, ...args: string[]) => string;
  tm: (msg: Msg) => string;
  /** A message whose `{0}`, `{1}`... are elements, e.g. a `<strong>` inside one sentence. */
  tr: (key: MessageKey, ...parts: ReactNode[]) => ReactNode;
  formatSize: (bytes: number) => string;
  formatDay: (iso: string | null | undefined) => string;
  formatList: (items: string[]) => string;
  changeLocale: (newLocale: Locale) => void;
  ready: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** Splits a translated template on `{n}` placeholders and puts elements in their place. */
export function interpolate(template: string, parts: ReactNode[]): ReactNode {
  return template.split(/(\{\d+\})/).map((piece, i) => {
    const m = piece.match(/^\{(\d+)\}$/);
    return <Fragment key={i}>{m ? parts[Number(m[1])] ?? piece : piece}</Fragment>;
  });
}

initI18n();

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  const changeLocale = useCallback((newLocale: Locale) => {
    setLocale(newLocale);
    setLocaleState(newLocale);
    document.documentElement.lang = newLocale;
  }, []);

  // Every function changes identity with the locale, so memoised text follows a language switch.
  const value = useMemo<I18nContextValue>(() => {
    const placeholders = ['{0}', '{1}', '{2}', '{3}'];
    return {
      locale,
      t: (key, ...args) => translate(key, ...args),
      tn: (key, count, ...args) => translatePlural(key, count, ...args),
      tm: (msg) => translateMsg(msg),
      tr: (key, ...parts) => interpolate(translate(key, ...placeholders.slice(0, parts.length)), parts),
      formatSize: (bytes) => i18nFormatSize(bytes),
      formatDay: (iso) => i18nFormatDay(iso),
      formatList: (items) => i18nFormatList(items),
      changeLocale,
      ready: true,
    };
  }, [locale, changeLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}
