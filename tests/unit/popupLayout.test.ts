import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync('src/entrypoints/popup/popup.css', 'utf8');

describe('Popup layout contract', () => {
  it('uses an explicit intrinsic Popup width for the toolbar surface', () => {
    const shell = stylesheet.match(/\.popup-shell\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(shell).toContain('inline-size: 760px;');
    expect(shell).toContain('block-size: 500px;');
    expect(shell).not.toContain('100vw');
    expect(shell).not.toContain('100vh');
  });
});
