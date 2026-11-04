import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('presentation import boundary', () => {
  it('rejects a direct provider import from Popup, My, and Inline', async () => {
    const eslint = new ESLint();
    for (const surface of ['popup', 'my', 'inline']) {
      const result = await eslint.lintText(
        "import { WhatsLinkProvider } from '../../infrastructure/provider/WhatsLinkProvider';\nvoid WhatsLinkProvider;",
        {
          filePath:
            surface === 'inline'
              ? 'src/content/Forbidden.tsx'
              : `src/entrypoints/${surface}/Forbidden.tsx`,
        },
      );
      expect(
        result[0]?.messages.some(
          (message) => message.ruleId === 'no-restricted-imports',
        ),
      ).toBe(true);
    }
  });
  it('keeps Inline on the shared scanner and free of direct transport or a second parser', () => {
    const inline = readFileSync('src/content/inlineRuntime.ts', 'utf8');
    expect(inline).toContain("from './magnetScanner'");
    expect(inline).not.toMatch(
      /\bfetch\s*\(|whatslink\.info|normalizeMagnet\s*\(|dangerouslySetInnerHTML/,
    );
  });
  it('keeps domain and scanner source free of forbidden runtime dependencies', () => {
    const domain =
      readFileSync('src/domain/magnet.ts', 'utf8') +
      readFileSync('src/domain/preview.ts', 'utf8');
    const scanner = readFileSync('src/content/magnetScanner.ts', 'utf8');
    expect(domain).not.toMatch(
      /from ['"]react|chrome\.|infrastructure\/provider/,
    );
    expect(scanner).not.toMatch(
      /entrypoints\/(popup|my)|from ['"]react|infrastructure\/provider/,
    );
  });
  it('allows an application contract import', async () => {
    const eslint = new ESLint();
    const result = await eslint.lintText(
      "import type { PreviewCommand } from '../../application/PreviewCommand';\nexport type Command = PreviewCommand;",
      { filePath: 'src/entrypoints/popup/Allowed.tsx' },
    );
    expect(
      result[0]?.messages.filter(
        (message) => message.ruleId === 'no-restricted-imports',
      ),
    ).toEqual([]);
  });
});
