import { describe, expect, it } from 'vitest';
import {
  parsePageToolVisibility,
  pageToolsDisabled,
} from '../../src/shared/preferences/pageToolVisibility';

describe('floating tool suppression', () => {
  it('migrates an absent record to enabled without blocked sites', () => {
    expect(parsePageToolVisibility(undefined)).toEqual({
      schemaVersion: 1,
      globalDisabled: false,
      disabledSites: [],
    });
  });
  it('keeps canonical site patterns only, deduplicated and sorted', () => {
    expect(
      parsePageToolVisibility({
        schemaVersion: 1,
        disabledSites: [
          'https://b.test/*',
          'https://a.test/*',
          'https://b.test/*',
          '<all_urls>',
          'https://a.test/private',
          1,
        ],
      }).disabledSites,
    ).toEqual(['https://a.test/*', 'https://b.test/*']);
  });
  it('suppresses the exact scheme and host including all ports without suppressing other sites', () => {
    const value = parsePageToolVisibility({
      schemaVersion: 1,
      disabledSites: ['https://example.test/*'],
    });
    expect(pageToolsDisabled(value, 'https://example.test:8080/private')).toBe(
      true,
    );
    expect(pageToolsDisabled(value, 'http://example.test/private')).toBe(false);
    expect(pageToolsDisabled(value, 'https://sub.example.test/private')).toBe(
      false,
    );
  });
  it('honors the explicit global boolean independently of site choices', () => {
    expect(
      pageToolsDisabled(
        parsePageToolVisibility({ schemaVersion: 1, globalDisabled: true }),
        'https://other.test/',
      ),
    ).toBe(true);
    expect(
      pageToolsDisabled(
        parsePageToolVisibility({ schemaVersion: 1, globalDisabled: 'true' }),
        'https://other.test/',
      ),
    ).toBe(false);
  });
});
