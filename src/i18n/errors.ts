import { t } from './index';

// Rust sends variant names, the language files use camelCase keys.
const KEY_FOR_CODE: Record<string, string> = {
  Serde: 'serialization',
  InvalidHeader: 'httpHeader',
};

export function errorKey(code: string): string {
  const name = KEY_FOR_CODE[code] ?? code.charAt(0).toLowerCase() + code.slice(1);
  return `errors.${name}`;
}

export function translateError(err: unknown): string {
  if (err === null || err === undefined) {
    return '';
  }

  if (typeof err === 'string') {
    return err;
  }

  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.code === 'string') {
      const code = obj.code;
      const detail = typeof obj.detail === 'string' ? obj.detail : '';
      const translationKey = errorKey(code);
      const translated = t(translationKey, detail);
      if (translated !== translationKey) {
        return translated;
      }
      return code;
    }
  }

  return String(err);
}