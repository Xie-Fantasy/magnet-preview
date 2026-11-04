import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function productFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productFiles(path);
    return /\.(?:css|html|json|svg|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('product-owned visual language', () => {
  it('does not embed emoji glyphs as UI artwork or chart stand-ins', () => {
    for (const path of [...productFiles('src'), ...productFiles('public')]) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(
        /\p{Extended_Pictographic}/u,
      );
    }
  });
});
