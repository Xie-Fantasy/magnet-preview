import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announceFavoriteChange,
  subscribeFavoriteChanges,
} from '../../src/shared/favoriteEvents';

afterEach(() => vi.unstubAllGlobals());

describe('favorite change hints', () => {
  it('keeps writes independent of BroadcastChannel and refreshes on focus', () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('unavailable');
        }
      },
    );
    const refresh = vi.fn();
    const unsubscribe = subscribeFavoriteChanges(refresh);
    expect(() => announceFavoriteChange()).not.toThrow();
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
