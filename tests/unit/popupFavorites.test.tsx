import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  FavoriteSaveFailure,
  type FavoriteStore,
} from '../../src/application/favorites';
import { FavoriteStoreContext, Popup } from '../../src/entrypoints/popup/Popup';
import { setProviderConsent } from '../../src/shared/preferences/providerConsent';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Popup favorite feedback', () => {
  it('waits for the transaction and shows a localized quota failure without claiming saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          JSON.parse(readFileSync('public/_locales/en/messages.json', 'utf8')),
      })),
    );
    setProviderConsent(false);
    const infoHash = 'A'.repeat(40);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash,
            originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
            canonicalMagnet: 'magnet:?xt=urn%3Abtih%3A' + infoHash,
          },
          occurrenceCount: 1,
        },
      ],
    } as never);
    let fail!: (reason: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const favoriteStore: FavoriteStore = {
      save: vi.fn().mockReturnValue(pending),
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
      getAsset: vi.fn().mockResolvedValue(null),
    };
    render(
      <FavoriteStoreContext.Provider value={favoriteStore}>
        <Popup />
      </FavoriteStoreContext.Provider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Scan current page' }),
    );
    const save = await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(save);
    expect(screen.getByText('Saving Favorite…')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fail(new FavoriteSaveFailure('quota')));
    expect(
      await screen.findByText(
        'Not enough browser storage to save this Favorite.',
      ),
    ).toBeTruthy();
    expect(save.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Saved to Favorites.')).toBeNull();
  });
});
