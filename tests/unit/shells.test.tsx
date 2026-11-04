import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Popup, FavoriteStoreContext } from '../../src/entrypoints/popup/Popup';
import type {
  FavoriteRecord,
  FavoriteStore,
} from '../../src/application/favorites';
import { MyPage } from '../../src/entrypoints/my/MyPage';
import { setProviderConsent } from '../../src/shared/preferences/providerConsent';
import type { PreviewCache } from '../../src/application/previewCache';

const cache: PreviewCache = {
  get: async () => null,
  put: async () => true,
  getAsset: async () => null,
  putAsset: async () => true,
  getPolicy: async () => ({
    schemaVersion: 1,
    ttlMs: 7 * 86_400_000,
    capBytes: 512 * 1024 * 1024,
  }),
  setPolicy: async () => undefined,
  stats: async () => ({ previewCount: 0, screenshotCount: 0, usedBytes: 0 }),
  clearDisposable: async () => undefined,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockCatalog() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const locale = url.includes('zh_CN') ? 'zh_CN' : 'en';
      return {
        ok: true,
        json: async () =>
          JSON.parse(
            readFileSync(`public/_locales/${locale}/messages.json`, 'utf8'),
          ),
      };
    }),
  );
}

describe('shell navigation', () => {
  it('keeps a pending favorite result attached to its resource after detail navigation', async () => {
    mockCatalog();
    setProviderConsent(false);
    const hashes = ['A'.repeat(40), 'B'.repeat(40)];
    const magnets = hashes.map((infoHash) => ({
      magnet: {
        infoHash,
        displayName: infoHash[0],
        originalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
        canonicalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
      },
      occurrenceCount: 1,
    }));
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets,
    } as never);
    const record: FavoriteRecord = {
      schemaVersion: 1,
      infoHash: hashes[0]!,
      snapshot: null,
      magnet: magnets[0]!.magnet.canonicalMagnet,
      assetIds: [],
      missingImageCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    let finish: ((record: FavoriteRecord) => void) | undefined;
    let saved = false;
    const store = {
      list: async () => (saved ? [record] : []),
      save: vi.fn(
        () =>
          new Promise<FavoriteRecord>((resolve) => {
            finish = resolve;
          }),
      ),
      remove: vi.fn(),
      getAsset: async () => null,
    } as unknown as FavoriteStore;
    const { container } = render(
      <FavoriteStoreContext.Provider value={store}>
        <Popup />
      </FavoriteStoreContext.Provider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Scan current page' }),
    );
    await screen.findByRole('heading', { name: 'A' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Open detail' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
    expect(
      container.querySelector('.detail-action-feedback')?.textContent,
    ).toBe('Saving Favorite…');
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Open detail' })[1]!);
    expect(
      container.querySelector('.detail-action-feedback')?.textContent,
    ).toBe('');
    await act(async () => {
      saved = true;
      finish!(record);
    });
    expect(
      container.querySelector('.detail-action-feedback')?.textContent,
    ).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Open detail' })[0]!);
    expect(
      container.querySelector('.detail-action-feedback')?.textContent,
    ).toBe('Saved to Favorites.');
    expect(store.save).toHaveBeenCalledExactlyOnceWith(
      record.magnet,
      undefined,
    );
    vi.spyOn(store, 'list').mockRejectedValue(
      new Error('fixture read failure'),
    );
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        container.querySelector('.detail-action-feedback')?.textContent,
      ).toBe('Could not update Favorites.'),
    );
  });
  it('keeps scans local until consent and tolerates an individual screenshot load failure', async () => {
    mockCatalog();
    const infoHash = '0123456789ABCDEF0123456789ABCDEF01234567';
    const magnet = {
      infoHash,
      originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
      canonicalMagnet: 'magnet:?xt=urn%3Abtih%3A' + infoHash,
    };
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets: [{ magnet, occurrenceCount: 1 }],
    } as never);
    let onMessage: ((value: unknown) => void) | undefined;
    const postMessage = vi.fn();
    const disconnect = vi.fn();
    chrome.runtime.connect = vi.fn(() => ({
      onMessage: {
        addListener: (listener: (value: unknown) => void) => {
          onMessage = listener;
        },
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect,
    })) as never;
    render(<Popup />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Scan current page' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Enable online previews?' }),
    ).toBeTruthy();
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep local only' }));
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enable previews' }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'preview',
      magnet: magnet.canonicalMagnet,
      infoHash,
      consentVersion: 1,
    });
    act(() =>
      onMessage?.({
        type: 'preview-result',
        infoHash,
        result: {
          infoHash,
          magnet: magnet.canonicalMagnet,
          providerId: 'whatslink',
          fetchedAt: 1,
          name: 'Returned title',
          totalBytes: 1024,
          fileCount: 1,
          files: [{ path: 'folder/<script>.mkv', bytes: 512 }],
          screenshots: [
            { id: '0', sourceUrl: 'https://whatslink.info/image.png' },
          ],
        },
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Returned title' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
    expect(screen.getByText('1.00 KiB')).toBeTruthy();
    expect(screen.getByText('folder/<script>.mkv')).toBeTruthy();
    expect(screen.queryByRole('script')).toBeNull();
    fireEvent.error(
      screen.getByRole('img', { name: /^Resource screenshot(?: \d+)?$/ }),
    );
    expect(screen.getByText('Screenshot unavailable.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'WhatsLink' })).toBeTruthy();
    act(() => setProviderConsent(false));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Returned title' }),
      ).toBeNull(),
    );
    expect(disconnect).toHaveBeenCalled();
  });
  it('offers a Retry action for an unavailable preview and sends one new manager request', async () => {
    mockCatalog();
    const infoHash = '0123456789ABCDEF0123456789ABCDEF01234567';
    const magnet = {
      infoHash,
      originalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
      canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${infoHash}`,
    };
    localStorage.setItem(
      'magnetPreview.providerConsent.v1',
      JSON.stringify({ version: 1, enabled: true }),
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets: [{ magnet, occurrenceCount: 1 }],
    } as never);
    let onMessage: ((value: unknown) => void) | undefined;
    const postMessage = vi.fn();
    chrome.runtime.connect = vi.fn(() => ({
      onMessage: {
        addListener: (listener: (value: unknown) => void) => {
          onMessage = listener;
        },
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect: vi.fn(),
    })) as never;
    try {
      render(<Popup />);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Scan current page' }),
      );
      await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
      act(() =>
        onMessage?.({
          type: 'preview-state',
          infoHash,
          state: {
            phase: 'unavailable',
            technicalDetails: { category: 'provider_unavailable' },
          },
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
      fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(postMessage).toHaveBeenLastCalledWith({
        type: 'preview',
        magnet: magnet.canonicalMagnet,
        infoHash,
        consentVersion: 1,
      });
      expect(
        screen.queryByRole('button', { name: 'Retry preview' }),
      ).toBeNull();
      act(() =>
        onMessage?.({
          type: 'preview-result',
          infoHash,
          result: {
            infoHash,
            magnet: magnet.canonicalMagnet,
            providerId: 'whatslink',
            fetchedAt: 1,
            name: 'Recovered',
            screenshots: [],
          },
        }),
      );
      expect(screen.getByRole('heading', { name: 'Recovered' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
      const catalog = JSON.parse(
        readFileSync('public/_locales/en/messages.json', 'utf8'),
      );
      expect(
        screen
          .getByRole('article', { name: 'Recovered' })
          .querySelector('.resource-card-metadata')?.textContent,
      ).toBe(catalog.occurrenceOnce.message);
    } finally {
      localStorage.removeItem('magnetPreview.providerConsent.v1');
    }
  });
  it('renders initial, scanning, empty, unsupported, and truncated scan states', async () => {
    mockCatalog();
    let resolveScan: (value: unknown) => void = () => undefined;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }) as never,
    );
    render(<Popup />);
    expect(
      await screen.findByText(
        'Use Scan current page above to find Magnet links on this page.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan current page' }));
    expect(await screen.findByText('Scanning this page…')).toBeTruthy();
    resolveScan({ kind: 'success', magnets: [], truncated: true });
    expect(
      await screen.findByText(
        'No valid Magnet resources were found on this page.',
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(/The scan reached its safety limit/),
    ).toBeTruthy();

    cleanup();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'unsupported_page',
    } as never);
    render(<Popup />);
    await screen.findByRole('heading', { name: 'Current page' });
    fireEvent.click(screen.getByRole('button', { name: 'Scan current page' }));
    expect(
      await screen.findByRole('heading', {
        name: 'This page cannot be scanned',
      }),
    ).toBeTruthy();
  });
  it('navigates Popup list to detail and back, then opens My page', async () => {
    mockCatalog();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash: '0123456789ABCDEF0123456789ABCDEF01234567',
            originalMagnet:
              'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
            canonicalMagnet:
              'magnet:?xt=urn%3Abtih%3A0123456789ABCDEF0123456789ABCDEF01234567',
          },
          occurrenceCount: 2,
        },
      ],
    } as never);
    render(<Popup />);
    expect(
      await screen.findByRole('heading', { name: 'Current page' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan current page' }));
    expect(
      await screen.findByRole('button', { name: 'Open detail' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
    expect(
      screen.getByRole('heading', { name: 'Resource detail' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'magnet:?xt=urn%3Abtih%3A0123456789ABCDEF0123456789ABCDEF01234567',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Magnet' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'magnet:?xt=urn%3Abtih%3A0123456789ABCDEF0123456789ABCDEF01234567',
      ),
    );
    expect(await screen.findByText('Magnet copied.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Current page' })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Open detail' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open My page' }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: '/my.html' });
  });
  it('keeps large discovery lists compact without exposing raw Magnet values', async () => {
    mockCatalog();
    const longName = '电影 🎬 '.repeat(24);
    const magnets = Array.from({ length: 20 }, (_, index) => {
      const infoHash = index.toString(16).padStart(40, '0').toUpperCase();
      return {
        magnet: {
          infoHash,
          displayName: `${longName}${index}`,
          originalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
          canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${infoHash}`,
        },
        occurrenceCount: index === 0 ? 4 : 1,
      };
    });
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets,
    } as never);
    render(<Popup />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Scan current page' }),
    );

    expect((await screen.findAllByRole('article')).length).toBe(20);
    expect(screen.getByText('Seen 4 times')).toBeTruthy();
    expect(screen.getAllByText('Seen once')).toHaveLength(19);
    expect(screen.getAllByRole('button', { name: 'Open detail' }).length).toBe(
      20,
    );
    expect(
      screen.queryByText(magnets[0]?.magnet.canonicalMagnet ?? ''),
    ).toBeNull();
    const secondDetail = screen.getAllByRole('button', {
      name: 'Open detail',
    })[1];
    if (!secondDetail) throw new Error('Second detail action is missing');
    fireEvent.click(secondDetail);
    expect(screen.getByText('Seen once')).toBeTruthy();
  });
  it('uses the selected native catalog and applies its theme tokens', async () => {
    mockCatalog();
    localStorage.setItem(
      'magnetPreview.preferences.v1',
      JSON.stringify({
        schemaVersion: 1,
        language: 'zh_CN',
        theme: {
          mode: 'dark',
          schedule: {
            darkStart: '19:00',
            lightStart: '07:00',
            timezone: 'local',
          },
        },
      }),
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash: '0123456789ABCDEF0123456789ABCDEF01234567',
            originalMagnet:
              'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
            canonicalMagnet:
              'magnet:?xt=urn%3Abtih%3A0123456789ABCDEF0123456789ABCDEF01234567',
          },
          occurrenceCount: 3,
        },
      ],
    } as never);
    render(<Popup />);
    expect(
      await screen.findByRole('heading', { name: '当前页面' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('dark'),
    );
    fireEvent.click(screen.getByRole('button', { name: '扫描当前页面' }));
    expect(await screen.findByText('出现 3 次')).toBeTruthy();
  });
  it('renders My tabs and switches language and theme', async () => {
    mockCatalog();
    render(<MyPage cache={cache} />);
    expect(
      await screen.findByRole('heading', { name: 'My page' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByLabelText('Theme'), {
      target: { value: 'dark' },
    });
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('dark'),
    );
    fireEvent.change(screen.getByLabelText('Language'), {
      target: { value: 'zh_CN' },
    });
    expect(
      await screen.findByRole('heading', { name: '我的页面' }),
    ).toBeTruthy();
  });
  it('keeps the My Settings preview switch synchronized with consent changed elsewhere', async () => {
    mockCatalog();
    render(<MyPage cache={cache} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const toggle = screen.getByLabelText(
      'Online previews via WhatsLink',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    act(() => setProviderConsent(true));
    expect(toggle.checked).toBe(true);

    act(() => {
      localStorage.setItem(
        'magnetPreview.providerConsent.v1',
        JSON.stringify({ version: 1, enabled: false }),
      );
      window.dispatchEvent(new Event('storage'));
    });
    expect(toggle.checked).toBe(false);
  });
});
