import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadMessages, message } from '../../src/shared/i18n';

describe('localized message templates', () => {
  it('keeps placeholders intact for the browser language until substitutions are supplied', async () => {
    vi.spyOn(chrome.i18n, 'getUILanguage').mockReturnValue('zh-CN');
    vi.spyOn(chrome.i18n, 'getMessage').mockReturnValue('出现 次');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          JSON.parse(
            readFileSync('public/_locales/zh_CN/messages.json', 'utf8'),
          ),
      })),
    );

    const messages = await loadMessages('browser');
    expect(messages.occurrences).toBe('出现 $COUNT$ 次');
    expect(message(messages, 'occurrences', ['2'])).toBe('出现 2 次');
  });
});
