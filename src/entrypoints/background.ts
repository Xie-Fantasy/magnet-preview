import { ProductionPreviewManager } from '../application/productionPreviewManager';
import { RequestCoordinator } from '../application/requestCoordinator';
import { normalizeMagnet } from '../domain/magnet';
import { WhatsLinkProvider } from '../infrastructure/provider/whatsLinkProvider';
import { IndexedDbPreviewCache } from '../infrastructure/storage/indexedDbPreviewCache';
import { IndexedDbFavorites } from '../infrastructure/storage/indexedDbFavorites';
import {
  fetchApprovedScreenshot,
  persistScreenshots,
} from '../infrastructure/storage/screenshotPersister';
import { PROVIDER_CONSENT_VERSION } from '../shared/preferences/providerConsent';
import type { InlinePresentation } from '../content/inlineRuntime';
import type { HoverPresentation } from '../content/hoverRuntime';
import {
  AUTO_CLEANUP_ALARM,
  AUTO_CLEANUP_KEY,
  getAutoCleanupHours,
} from '../shared/preferences/autoCleanup';
import { reconcileAutoCleanupAlarm } from '../application/autoCleanupScheduler';
import { sitePattern, siteScriptId } from '../shared/siteControl';
import { pageToolLabels } from '../shared/pageToolLabels';
import {
  PAGE_TOOL_VISIBILITY_KEY,
  getPageToolVisibility,
  parsePageToolVisibility,
  pageToolsDisabled,
  type PageToolVisibility,
} from '../shared/preferences/pageToolVisibility';
import { loadMessages, message as localizedMessage } from '../shared/i18n';
import type {
  Preferences,
  LanguagePreference,
} from '../shared/preferences/store';
import {
  parseThemePreference,
  resolveTheme,
} from '../shared/preferences/theme';

const cache = new IndexedDbPreviewCache();
const manager = new ProductionPreviewManager(
  new RequestCoordinator(new WhatsLinkProvider()),
  cache,
  (result) => persistScreenshots(result, cache),
);
const favorites = new IndexedDbFavorites(cache, Date.now, (image) =>
  image.sourceUrl
    ? fetchApprovedScreenshot(image.sourceUrl)
    : Promise.resolve(null),
);
const inlineGeneration = new Map<number, number>();
const pageToolsKey = (tabId: number) => `magnetPreview.pageTools.${tabId}`;
const pageToolsOperations = new Map<number, Promise<void>>();
let visibilityWrite = Promise.resolve();
function updateToolVisibility(
  change: (value: PageToolVisibility) => PageToolVisibility,
) {
  const operation = visibilityWrite.then(async () => {
    const stored = await chrome.storage.local.get(PAGE_TOOL_VISIBILITY_KEY);
    const raw = stored[PAGE_TOOL_VISIBILITY_KEY] as
      { schemaVersion?: unknown } | undefined;
    if (raw?.schemaVersion !== undefined && raw.schemaVersion !== 1)
      throw new Error('Unsupported visibility version');
    const next = change(parsePageToolVisibility(raw));
    await chrome.storage.local.set({ [PAGE_TOOL_VISIBILITY_KEY]: next });
  });
  visibilityWrite = operation.catch(() => undefined);
  return operation;
}

// Keep a late Show from restoring a tab session after Close or consent revocation.
function serializePageTools<T>(
  tabId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pageToolsOperations.get(tabId) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  pageToolsOperations.set(tabId, settled);
  void settled.then(() => {
    if (pageToolsOperations.get(tabId) === settled)
      pageToolsOperations.delete(tabId);
  });
  return current;
}

interface PageToolsSession {
  token: string;
  url: string;
  documentId: string;
  online: boolean;
  visible: boolean;
  presentation: InlinePresentation;
}
function validPageToolsInput(
  presentation: InlinePresentation | undefined,
  labels: Record<string, unknown> | undefined,
): presentation is InlinePresentation {
  return Boolean(
    presentation &&
    ['light', 'dark'].includes(presentation.theme) &&
    presentation.labels &&
    Object.values(presentation.labels).every(
      (value) => typeof value === 'string',
    ) &&
    labels &&
    Object.keys(pageToolLabels((key) => key)).every(
      (key) => typeof labels[key] === 'string',
    ),
  );
}
const hoverKey = (tabId: number) => `magnetPreview.hoverSession.${tabId}`;
interface HoverSession {
  token: string;
  url: string;
  online: boolean;
  hashes: string[];
}

async function revokeHover(tabId?: number): Promise<void> {
  if (tabId !== undefined) {
    await chrome.storage.session.remove(hoverKey(tabId));
    await chrome.tabs
      .sendMessage(tabId, { type: 'hover-remove' })
      .catch(() => undefined);
    return;
  }
  const stored = await chrome.storage.session.get(null);
  const ids = Object.keys(stored)
    .filter((key) => key.startsWith('magnetPreview.hoverSession.'))
    .map((key) => Number(key.slice('magnetPreview.hoverSession.'.length)))
    .filter(Number.isInteger);
  await chrome.storage.session.remove(ids.map(hoverKey));
  await Promise.all(
    ids.map((id) =>
      chrome.tabs
        .sendMessage(id, { type: 'hover-remove' })
        .catch(() => undefined),
    ),
  );
}

async function removePageToolsSession(tabId: number): Promise<void> {
  await chrome.storage.session.remove(pageToolsKey(tabId));
  inlineGeneration.set(tabId, (inlineGeneration.get(tabId) ?? 0) + 1);
  await chrome.tabs
    .sendMessage(tabId, { type: 'inline-remove' })
    .catch(() => undefined);
  await chrome.tabs
    .sendMessage(tabId, { type: 'page-tools-close' })
    .catch(() => undefined);
}

async function revokePageTools(tabId?: number): Promise<void> {
  const ids = new Set<number>(
    tabId === undefined ? pageToolsOperations.keys() : [tabId],
  );
  if (tabId === undefined) {
    const stored = await chrome.storage.session.get(null);
    for (const key of Object.keys(stored)) {
      if (!key.startsWith('magnetPreview.pageTools.')) continue;
      const id = Number(key.slice('magnetPreview.pageTools.'.length));
      if (Number.isInteger(id)) ids.add(id);
    }
    for (const id of pageToolsOperations.keys()) ids.add(id);
  }
  await Promise.all(
    [...ids].map((id) =>
      serializePageTools(id, () => removePageToolsSession(id)),
    ),
  );
}

async function thumbnailData(result: {
  infoHash: string;
  screenshots: Array<{ id: string; sourceUrl?: string }>;
}): Promise<string | undefined> {
  const first = result.screenshots[0];
  if (!first) return;
  const blob = await cache
    .getAsset(`${result.infoHash}:${first.id}`)
    .catch(() => null);
  if (
    !blob ||
    blob.size > 2 * 1024 * 1024 ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)
  )
    return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export default defineBackground(() => {
  let alarmSync = Promise.resolve();
  const syncCleanupAlarm = () => {
    alarmSync = alarmSync
      .then(async () => {
        const hours = await getAutoCleanupHours();
        await reconcileAutoCleanupAlarm(chrome.alarms, hours);
      })
      .catch(() => undefined);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && AUTO_CLEANUP_KEY in changes) syncCleanupAlarm();
    if (area === 'local' && PAGE_TOOL_VISIBILITY_KEY in changes) {
      // Queue after any in-progress Show/Close rather than await inside its tab operation.
      void chrome.storage.session
        .get(null)
        .then((stored) =>
          Promise.all(
            [
              ...new Set([
                ...pageToolsOperations.keys(),
                ...Object.keys(stored)
                  .filter((key) => key.startsWith('magnetPreview.pageTools.'))
                  .map((key) =>
                    Number(key.slice('magnetPreview.pageTools.'.length)),
                  )
                  .filter(Number.isInteger),
              ]),
            ].map((id) =>
              serializePageTools(id, async () => {
                const session = (
                  await chrome.storage.session.get(pageToolsKey(id))
                )[pageToolsKey(id)] as PageToolsSession | undefined;
                if (
                  session &&
                  pageToolsDisabled(await getPageToolVisibility(), session.url)
                )
                  await removePageToolsSession(id);
              }),
            ),
          ),
        )
        .catch(() => undefined);
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_CLEANUP_ALARM)
      void cache.stats().catch(() => undefined);
  });
  syncCleanupAlarm();
  chrome.tabs.onRemoved.addListener((tabId) => {
    inlineGeneration.delete(tabId);
    void chrome.storage.session.remove(hoverKey(tabId));
    void serializePageTools(tabId, () =>
      chrome.storage.session.remove(pageToolsKey(tabId)),
    );
  });
  chrome.permissions.onRemoved.addListener((removed) => {
    for (const origin of removed.origins ?? []) {
      void chrome.scripting
        .unregisterContentScripts({ ids: [siteScriptId(origin)] })
        .catch(() => undefined);
      void chrome.storage.session.get(null).then((stored) =>
        Promise.all(
          Object.entries(stored)
            .filter(
              ([key, value]) =>
                key.startsWith('magnetPreview.pageTools.') &&
                sitePattern((value as PageToolsSession).url) === origin,
            )
            .map(([key]) =>
              Number(key.slice('magnetPreview.pageTools.'.length)),
            )
            .filter(Number.isInteger)
            .map((tabId) => revokePageTools(tabId)),
        ),
      );
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'page-tools-restore') {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url?.split('#')[0] !== chrome.runtime.getURL('/my.html')
      )
        return;
      const site = message.site;
      if (
        site !== undefined &&
        (typeof site !== 'string' || sitePattern(site) !== site)
      )
        return;
      void updateToolVisibility((value) =>
        site === undefined
          ? { ...value, globalDisabled: false }
          : {
              ...value,
              disabledSites: value.disabledSites.filter(
                (item) => item !== site,
              ),
            },
      ).then(
        () => sendResponse({ kind: 'restored' }),
        () => sendResponse({ kind: 'unavailable' }),
      );
      return true;
    }
    if (message?.type === 'hover-revoke-all') {
      if (
        sender.id !== chrome.runtime.id ||
        ![
          chrome.runtime.getURL('/popup.html'),
          chrome.runtime.getURL('/my.html'),
        ].includes(sender.url?.split('#')[0] ?? '')
      )
        return;
      void revokeHover().then(() => sendResponse({ kind: 'removed' }));
      return true;
    }
    if (
      message?.type === 'hover-activate-tab' ||
      message?.type === 'hover-remove-tab'
    ) {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('/popup.html')
      )
        return;
      void (async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id || tab.id !== message.tabId || !tab.url)
          return { kind: 'unsupported_page' };
        if (message.type === 'hover-remove-tab') {
          await revokeHover(tab.id);
          return { kind: 'removed' };
        }
        const presentation = message.presentation as
          HoverPresentation | undefined;
        if (
          message.enabled !== true ||
          !presentation ||
          !['light', 'dark'].includes(presentation.theme) ||
          !presentation.labels ||
          [
            'loading',
            'unavailable',
            'localOnly',
            'identity',
            'size',
            'fileCount',
          ].some(
            (key) =>
              typeof presentation.labels[
                key as keyof HoverPresentation['labels']
              ] !== 'string',
          )
        )
          return { kind: 'disabled' };
        await revokeHover(tab.id);
        const token = crypto.randomUUID();
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['hover.js'],
        });
        const scan = (await chrome.tabs.sendMessage(tab.id, {
          type: 'hover-activate',
          token,
          presentation,
          online: message.consent === true,
        })) as { count: number; truncated: boolean; hashes: string[] };
        if (!Array.isArray(scan.hashes)) return { kind: 'unsupported_page' };
        const hashes = scan.hashes
          .filter((hash) => /^[A-F0-9]{40}$/.test(hash))
          .slice(0, 1000);
        const session: HoverSession = {
          token,
          url: tab.url,
          online: message.consent === true,
          hashes,
        };
        await chrome.storage.session.set({ [hoverKey(tab.id)]: session });
        return {
          kind: 'success',
          count: scan.count,
          truncated: scan.truncated,
        };
      })().then(sendResponse, () => sendResponse({ kind: 'unsupported_page' }));
      return true;
    }
    if (message?.type === 'hover-preview') {
      if (
        sender.id !== chrome.runtime.id ||
        !sender.tab?.id ||
        typeof message.token !== 'string' ||
        typeof message.infoHash !== 'string'
      )
        return;
      void (async () => {
        const session = (
          await chrome.storage.session.get(hoverKey(sender.tab!.id!))
        )[hoverKey(sender.tab!.id!)] as HoverSession | undefined;
        if (
          !session ||
          session.token !== message.token ||
          !session.online ||
          session.url !== sender.url ||
          !session.hashes.includes(message.infoHash)
        )
          return { kind: 'unavailable' };
        const magnet = normalizeMagnet(
          `magnet:?xt=urn:btih:${message.infoHash}`,
        );
        if (!magnet || magnet.infoHash !== message.infoHash)
          return { kind: 'unavailable' };
        try {
          const result = await manager.getPreview(magnet);
          await manager.waitForPersistence(magnet.infoHash);
          const thumbnail = await thumbnailData(result);
          return {
            kind: 'success',
            summary: {
              name: result.name,
              totalBytes: result.totalBytes,
              fileCount: result.fileCount,
              thumbnail,
            },
          };
        } catch {
          return { kind: 'unavailable' };
        }
      })().then(sendResponse, () => sendResponse({ kind: 'unavailable' }));
      return true;
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'page-tools-revoke-all') {
      if (
        sender.id !== chrome.runtime.id ||
        ![
          chrome.runtime.getURL('/popup.html'),
          chrome.runtime.getURL('/my.html'),
        ].includes(sender.url?.split('#')[0] ?? '')
      )
        return;
      void revokePageTools().then(() => sendResponse({ kind: 'closed' }));
      return true;
    }
    if (message?.type === 'page-tools-revoke-tab') {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('/popup.html') ||
        !Number.isInteger(message.tabId)
      )
        return;
      void revokePageTools(message.tabId).then(
        () => sendResponse({ kind: 'closed' }),
        () => sendResponse({ kind: 'unavailable' }),
      );
      return true;
    }
    if (message?.type === 'page-tools-auto-open') {
      if (
        sender.id !== chrome.runtime.id ||
        !sender.tab?.id ||
        !sender.tab.url ||
        sender.url !== sender.tab.url ||
        sender.frameId !== 0
      )
        return;
      const tabId = sender.tab.id;
      const tabUrl = sender.tab.url;
      const origin = sitePattern(tabUrl);
      if (!origin || typeof message.systemDark !== 'boolean') return;
      void (async () => {
        if (!(await chrome.permissions.contains({ origins: [origin] })))
          return { kind: 'unsupported_page' };
        return serializePageTools(tabId, async () => {
          if (pageToolsDisabled(await getPageToolVisibility(), tabUrl))
            return { kind: 'disabled' };
          const saved = await chrome.storage.local.get([
            'magnetPreview.providerConsentMirror.v1',
            'magnetPreview.preferencesMirror.v1',
          ]);
          const preference = saved['magnetPreview.preferencesMirror.v1'] as
            Preferences | undefined;
          const language: LanguagePreference =
            preference?.schemaVersion === 1 &&
            ['browser', 'en', 'zh_CN'].includes(preference.language)
              ? preference.language
              : 'browser';
          const catalog = await loadMessages(language);
          const label = (key: string) => localizedMessage(catalog, key);
          const presentation: InlinePresentation = {
            theme: resolveTheme(
              parseThemePreference(preference?.theme),
              message.systemDark,
            ),
            labels: {
              localOnly: label('inlineLocalOnly'),
              loading: label('inlineLoading'),
              unavailable: label('inlineUnavailable'),
              identity: label('magnetIdentity'),
              fileCount: label('previewFileCount'),
              size: label('previewSize'),
            },
          };
          const labels = pageToolLabels(label);
          const consent =
            saved['magnetPreview.providerConsentMirror.v1'] === true;
          try {
            const [injection] = await chrome.scripting.executeScript({
              target: { tabId },
              files: ['page-tools.js'],
            });
            const documentId = injection?.documentId;
            if (!documentId || documentId !== sender.documentId) {
              await chrome.storage.session.remove(pageToolsKey(tabId));
              return { kind: 'unsupported_page' };
            }
            const existing = (
              await chrome.storage.session.get(pageToolsKey(tabId))
            )[pageToolsKey(tabId)] as PageToolsSession | undefined;
            if (existing?.documentId !== documentId)
              inlineGeneration.set(
                tabId,
                (inlineGeneration.get(tabId) ?? 0) + 1,
              );
            const session: PageToolsSession =
              existing?.url === tabUrl && existing.documentId === documentId
                ? { ...existing, online: consent, presentation }
                : {
                    token: crypto.randomUUID(),
                    url: tabUrl,
                    documentId,
                    online: consent,
                    visible: false,
                    presentation,
                  };
            await chrome.storage.session.set({
              [pageToolsKey(tabId)]: session,
            });
            await chrome.tabs.sendMessage(tabId, {
              type: 'page-tools-open',
              token: session.token,
              theme: presentation.theme,
              labels,
              visible: session.visible,
              openSettings: false,
            });
            return { kind: 'ready' };
          } catch {
            await chrome.storage.session.remove(pageToolsKey(tabId));
            return { kind: 'unsupported_page' };
          }
        });
      })().then(sendResponse, () => sendResponse({ kind: 'unsupported_page' }));
      return true;
    }
    if (message?.type === 'page-tools-open-tab') {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('/popup.html')
      )
        return;
      void (async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id || tab.id !== message.tabId || !tab.url)
          return { kind: 'unsupported_page' };
        const presentation = message.presentation as
          InlinePresentation | undefined;
        const labels = message.labels as Record<string, unknown> | undefined;
        if (!validPageToolsInput(presentation, labels))
          return { kind: 'unsupported_page' };
        const tabId = tab.id;
        const tabUrl = tab.url;
        return serializePageTools(tabId, async () => {
          if (pageToolsDisabled(await getPageToolVisibility(), tabUrl))
            return { kind: 'disabled' };
          try {
            const [injection] = await chrome.scripting.executeScript({
              target: { tabId },
              files: ['page-tools.js'],
            });
            const documentId = injection?.documentId;
            if (!documentId || (await chrome.tabs.get(tabId)).url !== tabUrl) {
              await chrome.storage.session.remove(pageToolsKey(tabId));
              return { kind: 'unsupported_page' };
            }
            const existing = (
              await chrome.storage.session.get(pageToolsKey(tabId))
            )[pageToolsKey(tabId)] as PageToolsSession | undefined;
            if (existing?.documentId !== documentId)
              inlineGeneration.set(
                tabId,
                (inlineGeneration.get(tabId) ?? 0) + 1,
              );
            const session: PageToolsSession = {
              token: crypto.randomUUID(),
              url: tabUrl,
              documentId,
              online: message.consent === true,
              visible:
                existing?.visible === true &&
                existing.url === tabUrl &&
                existing.documentId === documentId,
              presentation,
            };
            await chrome.storage.session.set({
              [pageToolsKey(tabId)]: session,
            });
            await chrome.tabs.sendMessage(tabId, {
              type: 'page-tools-open',
              token: session.token,
              theme: presentation.theme,
              labels,
              visible: session.visible,
              openSettings: true,
            });
            return { kind: 'ready' };
          } catch {
            await chrome.storage.session.remove(pageToolsKey(tabId));
            return { kind: 'unsupported_page' };
          }
        });
      })().then(sendResponse, () => sendResponse({ kind: 'unsupported_page' }));
      return true;
    }
    if (
      message?.type === 'page-tools-dismiss' ||
      message?.type === 'page-tools-open-my' ||
      message?.type === 'page-tools-open-settings'
    ) {
      if (
        sender.id !== chrome.runtime.id ||
        !sender.tab?.id ||
        typeof message.token !== 'string'
      )
        return;
      void serializePageTools(sender.tab.id, async () => {
        const session = (
          await chrome.storage.session.get(pageToolsKey(sender.tab!.id!))
        )[pageToolsKey(sender.tab!.id!)] as PageToolsSession | undefined;
        if (
          !session ||
          session.token !== message.token ||
          session.url !== sender.url ||
          session.documentId !== sender.documentId
        )
          return { kind: 'unavailable' };
        if (
          message.type === 'page-tools-open-my' ||
          message.type === 'page-tools-open-settings'
        ) {
          await chrome.tabs.create({
            url: chrome.runtime.getURL(
              message.type === 'page-tools-open-settings'
                ? '/my.html#settings'
                : '/my.html',
            ),
          });
          return { kind: 'opened' };
        }
        if (!['visit', 'site', 'global'].includes(message.scope))
          return { kind: 'unavailable' };
        if (message.scope !== 'visit') {
          const origin = sitePattern(session.url);
          if (!origin) return { kind: 'unavailable' };
          await updateToolVisibility((value) =>
            message.scope === 'global'
              ? { ...value, globalDisabled: true }
              : {
                  ...value,
                  disabledSites: [
                    ...new Set([...value.disabledSites, origin]),
                  ].sort(),
                },
          );
        }
        await removePageToolsSession(sender.tab!.id!);
        return { kind: 'closed' };
      }).then(sendResponse, () => sendResponse({ kind: 'unavailable' }));
      return true;
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'page-tools-status-tab') {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('/popup.html')
      )
        return;
      void (async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id || tab.id !== message.tabId || !tab.url)
          return { kind: 'unsupported_page' };
        const stored = await chrome.storage.session.get([
          hoverKey(tab.id),
          pageToolsKey(tab.id),
        ]);
        const hover = stored[hoverKey(tab.id)] as HoverSession | undefined;
        const tools = stored[pageToolsKey(tab.id)] as
          PageToolsSession | undefined;
        const read = async (
          type: string,
          session?: { url: string; token: string },
        ) => {
          if (!session || session.url !== tab.url) return false;
          const response = await chrome.tabs
            .sendMessage(tab.id!, { type, token: session.token })
            .catch(() => null);
          return response?.active === true;
        };
        const [hoverActive, pageToolsActive] = await Promise.all([
          read('hover-status', hover),
          read('page-tools-status', tools),
        ]);
        return { kind: 'success', hoverActive, pageToolsActive };
      })().then(sendResponse, () => sendResponse({ kind: 'unsupported_page' }));
      return true;
    }
    if (
      message?.type !== 'inline-activate-tab' &&
      message?.type !== 'inline-remove-tab' &&
      message?.type !== 'page-tools-inline-toggle'
    )
      return;
    const fromPage = message.type === 'page-tools-inline-toggle';
    if (sender.id !== chrome.runtime.id) return;
    if (
      (!fromPage && sender.url !== chrome.runtime.getURL('/popup.html')) ||
      (fromPage && (!sender.tab?.id || typeof message.token !== 'string'))
    )
      return;
    const handleInline = async () => {
      const pageSession = fromPage
        ? ((await chrome.storage.session.get(pageToolsKey(sender.tab!.id!)))[
            pageToolsKey(sender.tab!.id!)
          ] as PageToolsSession | undefined)
        : undefined;
      if (
        fromPage &&
        (!pageSession ||
          pageSession.token !== message.token ||
          pageSession.url !== sender.url ||
          pageSession.documentId !== sender.documentId)
      )
        return { kind: 'unsupported_page' };
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tabId = activeTab?.id;
      if (!tabId || tabId !== (fromPage ? sender.tab?.id : message.tabId))
        return { kind: 'unsupported_page' };
      const generation = (inlineGeneration.get(tabId) ?? 0) + 1;
      inlineGeneration.set(tabId, generation);
      try {
        if (
          message.type === 'inline-remove-tab' ||
          (fromPage && pageSession?.visible)
        ) {
          const result = await chrome.tabs.sendMessage(tabId, {
            type: 'inline-remove',
          });
          if (fromPage && pageSession) {
            pageSession.visible = false;
            await chrome.storage.session.set({
              [pageToolsKey(tabId)]: pageSession,
            });
          }
          return { kind: fromPage ? 'hidden' : 'removed', ...result };
        }
        const presentation = (
          fromPage ? pageSession?.presentation : message.presentation
        ) as InlinePresentation | undefined;
        const online = fromPage
          ? pageSession?.online
          : message.consent === true;
        if (
          !presentation ||
          !['light', 'dark'].includes(presentation.theme) ||
          !presentation.labels ||
          Object.values(presentation.labels).some(
            (value) => typeof value !== 'string',
          )
        )
          return { kind: 'unsupported_page' };
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['inline.js'],
        });
        const scan = (await chrome.tabs.sendMessage(tabId, {
          type: 'inline-activate',
          presentation,
          online,
        })) as {
          magnets: Array<{ canonicalMagnet: string; infoHash: string }>;
          mounted: number;
          skipped: number;
          truncated: boolean;
        };
        if (online === true) {
          const unique = new Map(
            scan.magnets.map((magnet) => [magnet.infoHash, magnet]),
          );
          for (const input of unique.values()) {
            const magnet = normalizeMagnet(input.canonicalMagnet);
            if (!magnet || magnet.infoHash !== input.infoHash) continue;
            const post = (payload: Record<string, unknown>) => {
              if (inlineGeneration.get(tabId) !== generation) return;
              void chrome.tabs
                .sendMessage(tabId, {
                  type: 'inline-update',
                  infoHash: magnet.infoHash,
                  ...payload,
                })
                .catch(() => undefined);
            };
            const unsubscribe = manager.subscribe(magnet.infoHash, (state) =>
              post({ state }),
            );
            void manager
              .getPreview(magnet)
              .then(async (result) => {
                if (inlineGeneration.get(tabId) !== generation) return;
                post({
                  result: {
                    name: result.name,
                    totalBytes: result.totalBytes,
                    fileCount: result.fileCount,
                  },
                });
                await manager.waitForPersistence(magnet.infoHash);
                const thumbnail = await thumbnailData(result);
                if (thumbnail) post({ thumbnail });
              })
              .catch(() => undefined)
              .finally(unsubscribe);
          }
        }
        if (fromPage && pageSession) {
          pageSession.visible = true;
          await chrome.storage.session.set({
            [pageToolsKey(tabId)]: pageSession,
          });
        }
        return {
          kind: fromPage ? 'shown' : 'success',
          mounted: scan.mounted,
          skipped: scan.skipped,
          truncated: scan.truncated,
        };
      } catch {
        return { kind: 'unsupported_page' };
      }
    };
    void (
      fromPage
        ? serializePageTools(sender.tab!.id!, handleInline)
        : handleInline()
    ).then(sendResponse, () => sendResponse({ kind: 'unsupported_page' }));
    return true;
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'save-favorite') return;
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('/popup.html') ||
      typeof message.magnet !== 'string'
    )
      return;
    void favorites.save(message.magnet, message.snapshot).then(
      (record) => sendResponse({ kind: 'saved', record }),
      (error: unknown) =>
        sendResponse({
          kind: 'error',
          reason:
            error instanceof DOMException && error.name === 'QuotaExceededError'
              ? 'quota'
              : 'failed',
        }),
    );
    return true;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (
      port.name !== 'preview' ||
      port.sender?.id !== chrome.runtime.id ||
      port.sender.url !== chrome.runtime.getURL('/popup.html')
    )
      return;
    const unsubscribers = new Set<() => void>();
    let connected = true;
    port.onDisconnect.addListener(() => {
      connected = false;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.clear();
    });
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const input = message as Record<string, unknown>;
      if (
        input.type !== 'preview' ||
        input.consentVersion !== PROVIDER_CONSENT_VERSION ||
        typeof input.magnet !== 'string'
      )
        return;
      const magnet = normalizeMagnet(input.magnet);
      if (!magnet || magnet.infoHash !== input.infoHash) return;
      const post = (payload: unknown) => {
        if (!connected) return;
        try {
          port.postMessage(payload);
        } catch {
          /* Popup can close between state transitions. */
        }
      };
      const unsubscribe = manager.subscribe(magnet.infoHash, (state) =>
        post({ type: 'preview-state', infoHash: magnet.infoHash, state }),
      );
      unsubscribers.add(unsubscribe);
      void manager
        .getPreview(magnet)
        .then(
          (result) =>
            post({ type: 'preview-result', infoHash: magnet.infoHash, result }),
          () => {
            /* The sanitized state is already sent to the Popup. */
          },
        )
        .finally(() => {
          unsubscribe();
          unsubscribers.delete(unsubscribe);
        });
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'scan-active-tab') return;
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('/popup.html')
    )
      return;
    void Promise.resolve(
      message.tabId
        ? [{ id: message.tabId as number }]
        : chrome.tabs.query({ active: true, currentWindow: true }),
    ).then(async ([tab]) => {
      if (!tab?.id) return sendResponse({ kind: 'unsupported_page' });
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['scanner.js'],
        });
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'scan-current-document',
        });
        sendResponse({
          kind: 'success',
          truncated: result.truncated,
          magnets: result.magnets.map(
            (item: {
              magnet: { infoHash: string };
              occurrences: unknown[];
            }) => ({
              magnet: item.magnet,
              occurrenceCount: item.occurrences.length,
            }),
          ),
        });
      } catch {
        sendResponse({ kind: 'unsupported_page' });
      }
    });
    return true;
  });
});
