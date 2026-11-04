/* global URL, localStorage, chrome, setTimeout, clearTimeout, Buffer, console, document, queueMicrotask, window, Event, indexedDB, innerWidth, innerHeight, getComputedStyle, navigator */
// Local visual fixtures only. This never calls the live preview provider.
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve('docs/evidence/0014');
const extension = resolve('.output/chrome-mv3');
const profile = await mkdtemp(resolve(tmpdir(), 'magnet-visual-'));
await mkdir(output, { recursive: true });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  // Fail closed if any unexpected network request tries to leave the fixture.
  await context.route('https://**/*', (route) => route.abort());
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const theme of ['light', 'dark']) {
    for (const language of ['zh_CN', 'en']) {
      await page.goto(`chrome-extension://${id}/popup.html`);
      await page.evaluate(
        ({ theme, language }) => {
          localStorage.setItem(
            'magnetPreview.preferences.v1',
            JSON.stringify({
              schemaVersion: 1,
              language,
              theme: {
                mode: theme,
                schedule: {
                  darkStart: '19:00',
                  lightStart: '07:00',
                  timezone: 'local',
                },
              },
            }),
          );
          localStorage.setItem(
            'magnetPreview.providerConsent.v1',
            JSON.stringify({ version: 1, enabled: false }),
          );
        },
        { theme, language },
      );
      await page.reload();
      await page
        .getByRole('button', {
          name: language === 'zh_CN' ? '扫描当前页面' : 'Scan current page',
        })
        .waitFor();
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-empty-${language}-${theme}.png`),
      });
      await page.evaluate(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        const names = [
          '山间的四季 · 纪录片 / The mountain seasons',
          '城市漫游 — 1080p 修复版',
          '海岸线 / Coastline · 2160p',
        ];
        chrome.runtime.sendMessage = (message) =>
          message.type === 'scan-active-tab'
            ? Promise.resolve({
                kind: 'success',
                magnets: names.map((displayName, index) => {
                  const infoHash = String(index + 1).repeat(40);
                  return {
                    magnet: {
                      infoHash,
                      displayName,
                      canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${infoHash}`,
                      originalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
                    },
                    occurrenceCount: index === 0 ? 2 : 1,
                  };
                }),
              })
            : original(message);
      });
      await page
        .getByRole('button', {
          name: language === 'zh_CN' ? '扫描当前页面' : 'Scan current page',
        })
        .click();
      await page.locator('.resource-card').first().waitFor();
      await page
        .locator('.resource-shortcuts button[aria-pressed]')
        .first()
        .waitFor({ state: 'attached' });
      const tabTargets = {
        tools: '.popup-secondary-button',
        scan: '.popup-primary-button',
        resource: '.resource-card',
        copy: '.resource-shortcuts button:not([aria-pressed])',
        favorite: '.resource-shortcuts button[aria-pressed]',
        detail: '.resource-detail-button',
        my: '.popup-footer button',
        options: '.popup-page-options summary',
      };
      const tabVisited = new Set();
      await page.locator('.popup-primary-button').focus();
      await page.keyboard.press('Shift+Tab');
      for (let step = 0; step < 40; step++) {
        const focused = await page.evaluate((targets) => {
          const active = document.activeElement;
          const style = getComputedStyle(active);
          return {
            names: Object.entries(targets)
              .filter(([, selector]) => active.matches(selector))
              .map(([name]) => name),
            outline:
              style.outlineStyle !== 'none' &&
              parseFloat(style.outlineWidth) > 0,
          };
        }, tabTargets);
        for (const name of focused.names) tabVisited.add(name);
        if (focused.names.length && !focused.outline)
          throw new Error('Keyboard focus has no visible outline.');
        if (tabVisited.has('options')) break;
        await page.keyboard.press('Tab');
      }
      if (Object.keys(tabTargets).some((name) => !tabVisited.has(name)))
        throw new Error(
          `Incomplete Popup Tab route: ${[...tabVisited].join(', ')}`,
        );
      console.log(
        `${language}/${theme} keyboard route: ${[...tabVisited].join(', ')}`,
      );
      await page.evaluate(() => document.activeElement?.blur());
      const mergeNote = page.locator('.popup-merge-note');
      if (
        !(await mergeNote.isVisible()) ||
        !(await mergeNote.innerText()).trim()
      )
        throw new Error('InfoHash merge explanation is no longer visible.');
      const comparison = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.resource-card')];
        const last = cards[2].getBoundingClientRect();
        const footer = document
          .querySelector('.popup-footer')
          .getBoundingClientRect();
        return { lastCardBottom: last.bottom, footerTop: footer.top };
      });
      if (comparison.lastCardBottom > comparison.footerTop)
        throw new Error(
          `Three local comparison cards clipped: ${language}/${theme}`,
        );
      console.log(
        `${language}/${theme} local comparison: ${JSON.stringify(comparison)}`,
      );
      await page.mouse.move(0, 0);
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-results-${language}-${theme}.png`),
      });
      await page.locator('.resource-card').first().hover();
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-hover-${language}-${theme}.png`),
      });
      if (language === 'zh_CN') {
        const favorite = page
          .locator('.resource-shortcuts button[aria-pressed]')
          .first();
        await favorite.click();
        await page.waitForFunction(() =>
          document.querySelector(
            '.resource-shortcuts button[aria-pressed="true"]',
          ),
        );
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.activeElement?.blur());
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-saved-${theme}.png`),
        });
        await favorite.click();
        await page.waitForFunction(
          () =>
            !document.querySelector(
              '.resource-shortcuts button[aria-pressed="true"]',
            ),
        );
      }
      await page.locator('.resource-detail-button').first().click();
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-detail-${language}-${theme}.png`),
      });
      await page.locator('.popup-back').click();
      await page.evaluate(() => document.activeElement?.blur());
      await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 400;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = '#dbe7df';
        drawing.fillRect(0, 0, 640, 400);
        drawing.fillStyle = '#648871';
        drawing.beginPath();
        drawing.moveTo(0, 400);
        drawing.lineTo(210, 110);
        drawing.lineTo(460, 400);
        drawing.fill();
        drawing.fillStyle = '#355b44';
        drawing.beginPath();
        drawing.moveTo(250, 400);
        drawing.lineTo(460, 170);
        drawing.lineTo(640, 400);
        drawing.fill();
        drawing.fillStyle = '#fff';
        drawing.font = '16px sans-serif';
        drawing.fillText('LOCAL VISUAL FIXTURE', 24, 36);
        const image = canvas.toDataURL('image/png');
        drawing.fillStyle = '#b6cabd';
        drawing.fillRect(0, 0, 640, 100);
        drawing.fillStyle = '#355b44';
        drawing.fillText('LOCAL VISUAL FIXTURE — SECOND IMAGE', 24, 36);
        const secondImage = canvas.toDataURL('image/png');
        drawing.fillStyle = '#233e2e';
        drawing.fillRect(0, 0, 640, 100);
        drawing.fillStyle = '#fff';
        drawing.fillText('LOCAL VISUAL FIXTURE — THIRD IMAGE', 24, 36);
        const thirdImage = canvas.toDataURL('image/png');
        chrome.runtime.connect = () => {
          const listeners = [];
          window.__magnetVisualPreviewListeners = listeners;
          return {
            onMessage: { addListener: (listener) => listeners.push(listener) },
            onDisconnect: { addListener: () => {} },
            disconnect: () => {},
            postMessage: (message) =>
              queueMicrotask(() => {
                const response = message.infoHash.startsWith('1')
                  ? {
                      type: 'preview-result',
                      infoHash: message.infoHash,
                      result: {
                        infoHash: message.infoHash,
                        magnet: message.magnet,
                        providerId: 'whatslink',
                        fetchedAt: 1,
                        name: '山间的四季 / The mountain seasons',
                        totalBytes: 1932735283,
                        fileCount: 12,
                        screenshots: [
                          { id: '0', sourceUrl: image },
                          { id: '1', sourceUrl: secondImage },
                          { id: '2', sourceUrl: thirdImage },
                        ],
                      },
                    }
                  : {
                      type: 'preview-state',
                      infoHash: message.infoHash,
                      state: message.infoHash.startsWith('2')
                        ? {
                            phase: 'unavailable',
                            technicalDetails: {
                              category: 'provider_unavailable',
                            },
                          }
                        : { phase: 'queued' },
                    };
                listeners.forEach((listener) => listener(response));
              }),
          };
        };
        localStorage.setItem(
          'magnetPreview.providerConsent.v1',
          JSON.stringify({ version: 1, enabled: true }),
        );
        window.dispatchEvent(new Event('magnet-preview-provider-consent'));
      });
      await page.locator('.preview-thumb').waitFor();
      await page.mouse.move(0, 0);
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-mixed-${language}-${theme}.png`),
      });
      await page.locator('.resource-detail-button').first().click();
      const imageFrame = await page
        .locator('.preview-image-frame')
        .first()
        .boundingBox();
      const imageFooter = await page.locator('.popup-footer').boundingBox();
      if (
        !imageFrame ||
        !imageFooter ||
        imageFrame.y + imageFrame.height > imageFooter.y
      )
        throw new Error(
          'Popup gallery controls push the first image beneath the footer.',
        );
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-gallery-${language}-${theme}.png`),
      });
      for (const succeeds of [true, false]) {
        await page.evaluate((succeeds) => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async () => {
                if (!succeeds) throw new Error('fixture');
              },
            },
          });
        }, succeeds);
        await page.locator('.resource-detail-actions button').first().click();
        const copyMessages = JSON.parse(
          await readFile(
            resolve('public/_locales', language, 'messages.json'),
            'utf8',
          ),
        );
        await page.waitForFunction(
          (expected) =>
            document
              .querySelector('.detail-action-feedback')
              .textContent.trim() === expected,
          copyMessages[succeeds ? 'magnetCopied' : 'copyFailed'].message,
        );
        const afterCopy = await page
          .locator('.preview-image-frame')
          .first()
          .boundingBox();
        if (JSON.stringify(afterCopy) !== JSON.stringify(imageFrame))
          throw new Error('Copy feedback shifts the Popup image.');
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(
            output,
            `refined-detail-copy-${succeeds ? 'success' : 'failure'}-${language}-${theme}.png`,
          ),
        });
      }
      await page.evaluate(() => {
        delete navigator.clipboard;
      });
      const detailFavorite = page.locator('.detail-favorite-button');
      const beforeFavorite = await detailFavorite.boundingBox();
      const beforeFavoriteImage = await page
        .locator('.preview-image-frame')
        .first()
        .boundingBox();
      for (const pressed of ['true', 'false']) {
        await detailFavorite.click();
        await page.waitForFunction((pressed) => {
          const button = document.querySelector('.detail-favorite-button');
          return (
            !button.disabled && button.getAttribute('aria-pressed') === pressed
          );
        }, pressed);
        if (
          JSON.stringify(await detailFavorite.boundingBox()) !==
            JSON.stringify(beforeFavorite) ||
          JSON.stringify(
            await page.locator('.preview-image-frame').first().boundingBox(),
          ) !== JSON.stringify(beforeFavoriteImage)
        )
          throw new Error(
            'Favorite action feedback shifts its button or Popup image.',
          );
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(
            output,
            `refined-detail-favorite-${pressed === 'true' ? 'saved' : 'removed'}-${language}-${theme}.png`,
          ),
        });
      }
      if (language === 'zh_CN') {
        const gallery = page.locator('.preview-screenshots');
        await page
          .getByRole('button', { name: '下一张截图', exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document.querySelector('.screenshot-gallery-count').textContent ===
            '2 / 3',
        );
        await page
          .getByRole('button', { name: '上一张截图', exact: true })
          .click();
        await gallery.focus();
        for (let step = 0; step < 6; step++) {
          await gallery.press('ArrowRight');
          await page.waitForTimeout(100);
        }
        await page.waitForFunction(
          () => document.querySelector('.preview-screenshots').scrollLeft > 100,
        );
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-gallery-keyboard-${theme}.png`),
        });
        const frame = gallery.locator('.preview-image-frame').first();
        const before = await frame.boundingBox();
        await gallery.locator('img').first().dispatchEvent('error');
        await frame.locator('p').waitFor();
        const after = await frame.boundingBox();
        if (before.width !== after.width || before.height !== after.height)
          throw new Error('A missing Popup image changes its gallery frame.');
        await gallery.evaluate((node) => {
          node.scrollLeft = 0;
        });
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-gallery-missing-${theme}.png`),
        });
      }
      await page.locator('.popup-back').click();
      if (language === 'zh_CN') {
        await page.evaluate(() => {
          const infoHash = '2'.repeat(40);
          const response = {
            type: 'preview-result',
            infoHash,
            result: {
              infoHash,
              magnet: `magnet:?xt=urn:btih:${infoHash}`,
              providerId: 'whatslink',
              fetchedAt: 1,
              name: '仅标题的资源 / Metadata-only resource',
              screenshots: [],
            },
          };
          for (const listener of window.__magnetVisualPreviewListeners) {
            listener({
              type: 'preview-state',
              infoHash,
              state: { phase: 'success' },
            });
            listener(response);
          }
        });
        await page
          .getByRole('heading', {
            name: '仅标题的资源 / Metadata-only resource',
          })
          .waitFor();
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-metadata-only-${theme}.png`),
        });
        await page.evaluate(async () => {
          const tab = await chrome.tabs.getCurrent();
          await chrome.tabs.setZoom(tab.id, 2);
        });
        await page.screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-zoom-200-${theme}.png`),
        });
        const bounds = await page.evaluate(() => {
          const shell = document
            .querySelector('.popup-shell')
            .getBoundingClientRect();
          const footer = document
            .querySelector('.popup-footer')
            .getBoundingClientRect();
          return {
            width: shell.width,
            viewport: innerWidth,
            bottom: footer.bottom,
            height: innerHeight,
          };
        });
        if (
          bounds.width > bounds.viewport + 1 ||
          bounds.bottom > bounds.height + 1
        )
          throw new Error('200% tab zoom loses Popup containment.');
        await page.evaluate(async () => {
          const tab = await chrome.tabs.getCurrent();
          await chrome.tabs.setZoom(tab.id, 1);
        });
      }
      await page.setViewportSize({ width: 380, height: 280 });
      await page.evaluate(() => document.activeElement?.blur());
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-narrow-${language}-${theme}.png`),
      });
      await page.locator('.popup-page-options summary').click();
      await page.locator('.popup-shell').screenshot({
        animations: 'disabled',
        path: resolve(output, `refined-options-${language}-${theme}.png`),
      });
      await page.locator('.popup-page-options summary').press('Escape');
      if (
        await page
          .locator('.popup-page-options')
          .evaluate((details) => details.open)
      )
        throw new Error('Escape did not dismiss page options.');
      const overflow = await page
        .locator('.popup-shell')
        .evaluate((shell) => shell.scrollWidth > shell.clientWidth);
      if (overflow) throw new Error('Narrow Popup has horizontal overflow.');
      await page.setViewportSize({ width: 1280, height: 900 });
      // Reset before opening another page so the native provider remains off.
      await page.evaluate(() =>
        localStorage.setItem(
          'magnetPreview.providerConsent.v1',
          JSON.stringify({ version: 1, enabled: false }),
        ),
      );
      if (language === 'zh_CN') {
        await page.reload();
        await page
          .getByRole('button', { name: '扫描当前页面', exact: true })
          .waitFor();
        await page.evaluate(() => {
          const original = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (message) =>
            message.type === 'scan-active-tab'
              ? Promise.resolve({ kind: 'unsupported_page' })
              : original(message);
        });
        await page
          .getByRole('button', { name: '扫描当前页面', exact: true })
          .click();
        await page
          .getByRole('heading', { name: '此页面暂时无法扫描', exact: true })
          .waitFor();
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-unsupported-${theme}.png`),
        });
        await page.evaluate(() => {
          const original = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (message) =>
            message.type === 'scan-active-tab'
              ? new Promise(() => {})
              : original(message);
        });
        await page
          .getByRole('button', { name: '扫描当前页面', exact: true })
          .click();
        await page
          .getByRole('heading', { name: '正在扫描当前页面…', exact: true })
          .waitFor();
        await page.locator('.popup-shell').screenshot({
          animations: 'disabled',
          path: resolve(output, `refined-scanning-${theme}.png`),
        });
      }
    }
    await page.goto(`chrome-extension://${id}/my.html`);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 400;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#dbe7df';
      drawing.fillRect(0, 0, 640, 400);
      drawing.fillStyle = '#648871';
      drawing.beginPath();
      drawing.moveTo(0, 400);
      drawing.lineTo(260, 90);
      drawing.lineTo(560, 400);
      drawing.fill();
      drawing.fillStyle = '#fff';
      drawing.font = '16px sans-serif';
      drawing.fillText('LOCAL VISUAL FIXTURE', 24, 36);
      const image = await new Promise((resolveImage) =>
        canvas.toBlob(resolveImage, 'image/png'),
      );
      const request = indexedDB.open('magnet-favorites', 1);
      const database = await new Promise((resolveDB, reject) => {
        request.onsuccess = () => resolveDB(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('favorites', {
            keyPath: 'infoHash',
          });
          request.result.createObjectStore('assets');
        };
      });
      const transaction = database.transaction(
        ['favorites', 'assets'],
        'readwrite',
      );
      const records = transaction.objectStore('favorites');
      records.clear();
      [
        '山间的四季 / The mountain seasons',
        '城市漫游 — 1080p 修复版',
        '海岸线 / Coastline',
      ].forEach((name, index) => {
        const infoHash = String(index + 1).repeat(40);
        const magnet = `magnet:?xt=urn%3Abtih%3A${infoHash}&dn=${encodeURIComponent(name)}`;
        records.put({
          schemaVersion: 1,
          infoHash,
          magnet,
          snapshot: {
            infoHash,
            magnet,
            providerId: 'whatslink',
            fetchedAt: 1,
            name,
            totalBytes: 1932735283,
            fileCount: 12,
            screenshots:
              index === 0
                ? [{ id: '0' }, { id: '1' }, { id: '2' }]
                : index === 1
                  ? [{ id: '0' }]
                  : [],
          },
          assetIds: index === 0 ? ['0', '1', '2'] : index === 1 ? ['0'] : [],
          missingImageCount: 0,
          createdAt: 1,
          updatedAt: 1,
        });
        if (index < 2)
          transaction.objectStore('assets').put(image, infoHash + ':0');
        if (index === 0) {
          transaction.objectStore('assets').put(image, infoHash + ':1');
          transaction.objectStore('assets').put(image, infoHash + ':2');
        }
      });
      await new Promise((resolveTx, reject) => {
        transaction.oncomplete = resolveTx;
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await page.reload();
    await page.locator('.favorite-list article').first().waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorites-${theme}.png`),
    });
    const firstFavorite = page.locator('.favorite-list article').first();
    await firstFavorite.locator('.favorite-actions button').first().click();
    const favoriteFrame = firstFavorite
      .locator('.favorite-image-frame')
      .first();
    await favoriteFrame.locator('img').waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorite-expanded-${theme}.png`),
    });
    const frameBefore = await favoriteFrame.boundingBox();
    await firstFavorite
      .getByRole('button', { name: /Next screenshot|下一张截图/ })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('.favorite-list .screenshot-gallery-count')
          .textContent === '2 / 3',
    );
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorite-gallery-next-${theme}.png`),
    });
    const favoriteGallery = firstFavorite.locator('.favorite-images');
    await favoriteGallery.focus();
    await favoriteGallery.press('Home');
    await favoriteFrame.locator('img').dispatchEvent('error');
    await favoriteFrame.locator('p').waitFor();
    const frameAfter = await favoriteFrame.boundingBox();
    if (
      frameBefore.width !== frameAfter.width ||
      frameBefore.height !== frameAfter.height
    )
      throw new Error('A missing favorite image changes its gallery frame.');
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorite-missing-${theme}.png`),
    });
    await firstFavorite.locator('.favorite-actions button').first().click();
    const downloadEvent = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Offline HTML', exact: true })
      .click();
    const download = await downloadEvent;
    const exportPath = resolve(profile, `offline-${theme}.html`);
    await download.saveAs(exportPath);
    const exportNetwork = [];
    const trackExportNetwork = (request) => {
      if (/^https?:/.test(request.url())) exportNetwork.push(request.url());
    };
    const offline = await context.newPage();
    offline.on('request', trackExportNetwork);
    await offline.goto(pathToFileURL(exportPath).href);
    if (theme === 'dark') await offline.locator('.theme-toggle').click();
    await offline.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-offline-${theme}.png`),
    });
    const offlineErrors = [];
    offline.on('pageerror', (error) => offlineErrors.push(error.message));
    const offlineCard = offline.locator('article').first();
    await offlineCard.locator('[data-toggle]').click();
    await offlineCard.getByRole('button', { name: 'Next screenshot' }).click();
    await offline.waitForFunction(
      () =>
        document.querySelector('article .gallery-count').textContent ===
        '2 / 3',
    );
    await offlineCard.locator('.gallery').press('End');
    await offline.waitForFunction(
      () =>
        document.querySelector('article .gallery-count').textContent ===
        '3 / 3',
    );
    if (
      !(await offlineCard
        .getByRole('button', { name: 'Next screenshot' })
        .isDisabled())
    )
      throw new Error('Offline final-slide Next remains active.');
    await offlineCard.locator('.gallery').press('Home');
    await offline.waitForFunction(
      () =>
        document.querySelector('article .gallery-count').textContent ===
        '1 / 3',
    );
    await offline.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-offline-gallery-${theme}.png`),
    });
    if (offlineErrors.length) throw new Error(offlineErrors.join('\n'));
    await offline.close();
    const zipDownloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Full ZIP', exact: true }).click();
    const zipDownload = await zipDownloadEvent;
    const zipEntries = unzipSync(await readFile(await zipDownload.path()));
    const zipRoot = resolve(profile, `offline-zip-${theme}`);
    await mkdir(zipRoot, { recursive: true });
    for (const [name, data] of Object.entries(zipEntries)) {
      const destination = resolve(zipRoot, name);
      if (!destination.startsWith(zipRoot + sep))
        throw new Error('Unexpected export archive path.');
      await mkdir(resolve(destination, '..'), { recursive: true });
      await writeFile(destination, data);
    }
    const zipPage = await context.newPage();
    zipPage.on('request', trackExportNetwork);
    await zipPage.goto(
      pathToFileURL(resolve(zipRoot, 'collection/index.html')).href,
    );
    const zipCard = zipPage.locator('article').first();
    await zipCard.locator('[data-toggle]').click();
    await zipCard.getByRole('button', { name: 'Next screenshot' }).click();
    await zipPage.waitForFunction(
      () =>
        document.querySelector('article .gallery-count').textContent ===
        '2 / 3',
    );
    if (
      !(await zipCard
        .locator('.gallery img')
        .evaluateAll((images) =>
          images.every((image) => image.complete && image.naturalWidth > 0),
        ))
    )
      throw new Error('Extracted ZIP images unavailable.');
    await zipPage.close();
    if (exportNetwork.length)
      throw new Error('Offline export attempted a network request.');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-settings-${theme}.png`),
    });
    await page.emulateMedia({
      forcedColors: 'active',
      reducedMotion: 'reduce',
    });
    const nativeCheckbox = await page
      .locator('.settings-form input[type="checkbox"]')
      .first()
      .evaluate((node) => ({
        appearance: getComputedStyle(node).appearance,
        knob: getComputedStyle(node, '::before').display,
      }));
    if (nativeCheckbox.appearance !== 'auto' || nativeCheckbox.knob !== 'none')
      throw new Error(
        'Forced-color settings do not restore native checkboxes.',
      );
    const hoverCheckbox = page
      .locator('.settings-form input[type="checkbox"]')
      .last();
    const hoverWasChecked = await hoverCheckbox.isChecked();
    await hoverCheckbox.check();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-settings-forced-colors-${theme}.png`),
    });
    await hoverCheckbox.setChecked(hoverWasChecked);
    await page.emulateMedia({
      forcedColors: 'none',
      reducedMotion: 'no-preference',
    });
    await page.getByRole('button', { name: 'Cache', exact: true }).click();
    await page.locator('.cache-gauge canvas').waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-cache-${theme}.png`),
    });
    await page
      .getByRole('button', { name: 'Clear preview cache', exact: true })
      .click();
    await page.locator('.cache-clear-confirm').waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-cache-confirm-${theme}.png`),
    });
    await page
      .locator('.cache-clear-confirm')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await page.evaluate(() => {
      const preferences = JSON.parse(
        localStorage.getItem('magnetPreview.preferences.v1'),
      );
      preferences.language = 'zh_CN';
      localStorage.setItem(
        'magnetPreview.preferences.v1',
        JSON.stringify(preferences),
      );
    });
    await page.reload();
    await page.locator('.favorite-list article').first().waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorites-zh_CN-${theme}.png`),
    });
    const zhDownloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '离线 HTML', exact: true }).click();
    const zhDownload = await zhDownloadEvent;
    const zhExportPath = resolve(profile, `offline-zh-${theme}.html`);
    await zhDownload.saveAs(zhExportPath);
    const zhOffline = await context.newPage();
    zhOffline.on('request', trackExportNetwork);
    await zhOffline.goto(pathToFileURL(zhExportPath).href);
    if (theme === 'dark') await zhOffline.locator('.theme-toggle').click();
    const zhCard = zhOffline.locator('article').first();
    await zhCard.locator('[data-toggle]').click();
    await zhCard
      .getByRole('button', { name: '下一张截图', exact: true })
      .click();
    await zhOffline.waitForFunction(
      () =>
        document.querySelector('article .gallery-count').textContent ===
        '2 / 3',
    );
    await zhOffline.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-offline-gallery-zh_CN-${theme}.png`),
    });
    await zhOffline.locator('#search').fill('no matching local fixture');
    await zhOffline.locator('#no-matches:not([hidden])').waitFor();
    await zhOffline.locator('#search').fill('');
    await zhCard.waitFor();
    await zhOffline.close();
    if (exportNetwork.length)
      throw new Error('Chinese offline export attempted a network request.');
    await page.locator('#favorite-search').fill('no matching local fixture');
    await page.locator('.favorite-no-matches').waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorite-search-empty-${theme}.png`),
    });
    await page.locator('#favorite-search').fill('');
    await page.locator('.favorite-list article').first().waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-settings-zh_CN-${theme}.png`),
    });
    await page.getByRole('button', { name: '缓存', exact: true }).click();
    await page.locator('.cache-gauge canvas').waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-cache-zh_CN-${theme}.png`),
    });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-cache-narrow-${theme}.png`),
    });
    await page.getByRole('button', { name: '收藏', exact: true }).click();
    await page.locator('.favorite-list article').first().waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorites-narrow-${theme}.png`),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    // This disposable profile contains only the synthetic records created above.
    await page.evaluate(
      () =>
        new Promise((resolveClear, reject) => {
          const request = indexedDB.open('magnet-favorites', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction(
              ['favorites', 'assets'],
              'readwrite',
            );
            transaction.objectStore('favorites').clear();
            transaction.objectStore('assets').clear();
            transaction.oncomplete = () => {
              database.close();
              resolveClear();
            };
            transaction.onerror = () => {
              database.close();
              reject(transaction.error);
            };
          };
        }),
    );
    await page.reload();
    await page.locator('.collection-empty').waitFor();
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `refined-favorites-empty-${theme}.png`),
    });
  }
  // Capture Chromium's action target rather than a normal extension tab.
  const cdp = await context.newCDPSession(page);
  await worker.evaluate(() => chrome.action.openPopup());
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((target) =>
    target.url.endsWith('/popup.html'),
  );
  if (!target) throw new Error('Action Popup target missing.');
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  });
  const result = new Promise((resolveResponse, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Action screenshot timed out.')),
      5000,
    );
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      if (event.sessionId !== sessionId) return;
      const response = JSON.parse(event.message);
      if (response.id === 1) {
        clearTimeout(timer);
        resolveResponse(response);
      }
    });
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: 'Page.captureScreenshot',
      params: { format: 'png', captureBeyondViewport: false },
    }),
  });
  const response = await result;
  await writeFile(
    resolve(output, 'refined-action-popup.png'),
    Buffer.from(response.result.data, 'base64'),
  );
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Captured local visual fixtures and action Popup; no page errors.',
  );
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
