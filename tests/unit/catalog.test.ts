import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (locale: string) =>
  JSON.parse(
    readFileSync(`public/_locales/${locale}/messages.json`, 'utf8'),
  ) as Record<
    string,
    { message: string; placeholders?: Record<string, { content: string }> }
  >;

describe('native locale catalogs', () => {
  it('have matching nonempty keys for current surfaces', () => {
    const en = read('en');
    const zh = read('zh_CN');
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(en)) {
      expect(en[key]?.message.trim()).toBeTruthy();
      expect(zh[key]?.message.trim()).toBeTruthy();
    }
    for (const key of [
      'popupTitle',
      'detailTitle',
      'myTitle',
      'favorites',
      'cache',
      'settings',
      'theme',
      'language',
    ])
      expect(en[key]).toBeDefined();
  });

  it('declares every Chrome i18n message placeholder', () => {
    for (const locale of ['en', 'zh_CN']) {
      for (const entry of Object.values(read(locale))) {
        for (const token of entry.message.matchAll(/\$([A-Z0-9_]+)\$/g)) {
          expect(
            entry.placeholders?.[token[1]?.toLowerCase() ?? ''],
          ).toBeDefined();
        }
      }
    }
  });
});
