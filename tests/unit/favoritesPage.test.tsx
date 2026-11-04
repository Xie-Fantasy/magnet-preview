import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { FavoritesPage } from '../../src/entrypoints/my/FavoritesPage';
import { Blob as NodeBlob } from 'node:buffer';
import type {
  FavoriteRecord,
  FavoriteStore,
} from '../../src/application/favorites';

const hash = 'A'.repeat(40);
const magnet = 'magnet:?xt=urn%3Abtih%3A' + hash + '&dn=Saved+title';
const record: FavoriteRecord = {
  schemaVersion: 1,
  infoHash: hash,
  magnet,
  snapshot: {
    infoHash: hash,
    magnet: 'magnet:?xt=urn:btih:' + hash,
    name: 'Saved title',
    screenshots: [{ id: '0' }],
    providerId: 'whatslink',
    fetchedAt: 1,
  },
  assetIds: ['0'],
  missingImageCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const t = (key: string) =>
  ({
    openDetail: 'Open detail',
    collapseFavorite: 'Collapse',
    favoriteSearch: 'Search titles',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    back: 'Back',
    previewScreenshot: 'Resource screenshot',
    favoriteImageLoading: 'Loading saved image…',
    favoriteImageMissing: 'Local preview image is unavailable.',
    removeFavorite: 'Remove saved',
    copyMagnet: 'Copy Magnet',
  })[key] ?? key;

function store(getAsset: FavoriteStore['getAsset']): FavoriteStore {
  return {
    save: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([record]),
    remove: vi.fn().mockResolvedValue(undefined),
    getAsset,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('offline favorite images', () => {
  it('does not report an empty collection when reading favorites fails', async () => {
    const failingStore = {
      ...store(async () => null),
      list: vi.fn().mockRejectedValue(new Error('local read failed')),
    };
    render(<FavoritesPage store={failingStore} t={t} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(t('favoritesEmpty'))).toBeNull();
    expect(screen.queryByText('local read failed')).toBeNull();
  });

  it('keeps one thumbnail in a collapsed row and browses all owned images when expanded', async () => {
    const create = vi.fn((blob: Blob) => `blob:owned-${blob.size}`);
    const BaseURL = URL;
    class ObjectUrl extends BaseURL {
      static override createObjectURL = create;
      static override revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', ObjectUrl);
    const many = {
      ...record,
      assetIds: ['0', '1', '2', '3', '4'],
      snapshot: {
        ...record.snapshot!,
        screenshots: ['0', '1', '2', '3', '4'].map((id) => ({ id })),
      },
    };
    const favoriteStore = {
      ...store(vi.fn(async () => new Blob(['owned'], { type: 'image/png' }))),
      list: vi.fn().mockResolvedValue([many]),
      get: vi.fn().mockResolvedValue(many),
    };
    render(<FavoritesPage store={favoriteStore} t={t} />);
    await waitFor(() =>
      expect(document.querySelectorAll('.favorite-thumbnail')).toHaveLength(1),
    );
    expect(document.querySelectorAll('.favorite-images img')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
    await waitFor(() =>
      expect(document.querySelectorAll('.favorite-images img')).toHaveLength(5),
    );
    expect(favoriteStore.getAsset).toHaveBeenCalled();
  });

  it('shows loading before the local Blob and revokes expanded URLs on collapse', async () => {
    let release!: (blob: Blob | null) => void;
    const pending = new Promise<Blob | null>((resolve) => {
      release = resolve;
    });
    const create = vi.fn().mockReturnValue('blob:local-owned');
    const revoke = vi.fn();
    const BaseURL = URL;
    class ObjectUrl extends BaseURL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', ObjectUrl);
    render(<FavoritesPage store={store(() => pending)} t={t} />);
    const open = await screen.findByRole('button', { name: 'Open detail' });
    fireEvent.click(open);
    expect(screen.getByText('Loading saved image…')).toBeTruthy();
    expect(
      screen.queryByText('Local preview image is unavailable.'),
    ).toBeNull();
    await act(async () => release(new Blob(['owned'], { type: 'image/png' })));
    expect(
      screen.getAllByRole('img', { name: /^Resource screenshot(?: \d+)?$/ }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith('blob:local-owned'),
    );
    await waitFor(() =>
      expect(document.querySelectorAll('.favorite-images img')).toHaveLength(0),
    );
  });

  it('filters titles and expands the visible result without exposing its Magnet while collapsed', async () => {
    render(<FavoritesPage store={store(async () => null)} t={t} />);
    await screen.findByRole('button', { name: 'Open detail' });
    expect(document.querySelector('.favorite-magnet-field')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search titles' }), {
      target: { value: 'missing' },
    });
    expect(document.querySelectorAll('.favorite-list article')).toHaveLength(0);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search titles' }), {
      target: { value: 'saved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(document.querySelector('.favorite-magnet-field')).not.toBeNull();
  });

  it('shows a missing state only after the owned image lookup fails', async () => {
    let release!: (blob: Blob | null) => void;
    const pending = new Promise<Blob | null>((resolve) => {
      release = resolve;
    });
    render(<FavoritesPage store={store(() => pending)} t={t} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open detail' }));
    expect(screen.getByText('Loading saved image…')).toBeTruthy();
    await act(async () => release(null));
    expect(
      screen.getByText('Local preview image is unavailable.'),
    ).toBeTruthy();
  });
});

describe('favorite export downloads', () => {
  it('starts one export for rapid clicks and revokes its URL on unmount', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const create = vi.fn().mockReturnValue('blob:export');
    const revoke = vi.fn();
    const BaseURL = URL;
    class ObjectUrl extends BaseURL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', ObjectUrl);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const favoriteStore = store(async () => null);
    const view = render(
      <FavoritesPage store={favoriteStore} t={t} exportLocale="zh_CN" />,
    );
    const button = await screen.findByRole('button', { name: 'exportHtml' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(click).toHaveBeenCalledTimes(1);
    expect(await (create.mock.calls[0]![0] as Blob).text()).toContain(
      '<html lang="zh-CN">',
    );
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:export');
    click.mockRestore();
  });
});
