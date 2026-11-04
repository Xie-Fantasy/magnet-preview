import { test, expect, chromium } from '@playwright/test';
import { cp, readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { listenFixture } from './fixtureServer';

test('site grant shows only the compact control on future visits and can be revoked', async () => {
  const fixture = await readFile(
    resolve('tests/e2e/fixtures/release-review.html'),
    'utf8',
  );
  const server = createServer((_request, response) => response.end(fixture));
  const address = await listenFixture(server);
  const fixtureUrl = `http://127.0.0.1:${address.port}/release-review.html`;
  const profile = await mkdtemp(resolve(tmpdir(), 'magnet-site-control-'));
  const extension = resolve(profile, 'extension');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestPath = resolve(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const external: string[] = [];
  context.on('request', (request) => {
    if (request.url().startsWith('https://')) external.push(request.url());
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    const tabId = await worker.evaluate(
      async () =>
        (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
    );
    expect(tabId).toBeTruthy();
    const popup = await context.newPage();
    await popup.addInitScript(
      ({ tabId, fixtureUrl }) => {
        localStorage.setItem(
          'magnetPreview.preferences.v1',
          JSON.stringify({ schemaVersion: 1, language: 'en' }),
        );
        const native = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
          query.active
            ? [{ id: tabId, url: fixtureUrl }]
            : native(query)) as typeof chrome.tabs.query;
      },
      { tabId, fixtureUrl },
    );
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    );
    const summary = popup.locator('.popup-page-options summary');
    const closedBounds = await summary.boundingBox();
    await summary.click();
    expect(await summary.boundingBox()).toEqual(closedBounds);
    await expect(
      popup.getByRole('button', { name: 'Always show button on this site' }),
    ).toBeVisible();
    await popup
      .getByRole('button', { name: 'Always show button on this site' })
      .click();
    await expect(
      popup.getByRole('button', { name: 'Stop showing button on this site' }),
    ).toBeVisible();
    const dock = page.locator('magnet-preview-tools');
    await page.reload();
    await expect(dock).toHaveCount(1);
    const bounds = await dock.boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(88);
    const labels = await dock.evaluate((node) =>
      [...node.shadowRoot!.querySelectorAll('button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    );
    expect(labels.some((label) => label === 'Close' || label === '关闭')).toBe(
      true,
    );
    await popup.close();
    await page.bringToFront();
    const toggle = dock.locator('button.toggle');
    const beforeDrag = (await toggle.boundingBox())!;
    const closeBounds = (await dock.locator('button.close').boundingBox())!;
    const gap =
      Math.hypot(
        closeBounds.x +
          closeBounds.width / 2 -
          beforeDrag.x -
          beforeDrag.width / 2,
        closeBounds.y +
          closeBounds.height / 2 -
          beforeDrag.y -
          beforeDrag.height / 2,
      ) -
      (beforeDrag.width + closeBounds.width) / 2;
    expect(gap).toBeGreaterThan(1);
    expect(gap).toBeLessThan(5);
    const crossBounds = (await dock.locator('button.close svg').boundingBox())!;
    expect(crossBounds.x + crossBounds.width / 2).toBeCloseTo(
      closeBounds.x + closeBounds.width / 2,
      1,
    );
    expect(crossBounds.y + crossBounds.height / 2).toBeCloseTo(
      closeBounds.y + closeBounds.height / 2,
      1,
    );
    await mkdir(resolve('docs/evidence/0016'), { recursive: true });
    await dock.screenshot({
      path: resolve('docs/evidence/0016/floating-button-light.png'),
    });
    await dock.evaluate((node) => {
      (node as HTMLElement).dataset.theme = 'dark';
    });
    await dock.screenshot({
      path: resolve('docs/evidence/0016/floating-button-dark.png'),
    });
    await dock.evaluate((node) => {
      (node as HTMLElement).dataset.theme = 'light';
    });
    await page.mouse.move(
      beforeDrag.x + beforeDrag.width / 2,
      beforeDrag.y + beforeDrag.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(180, 180, { steps: 12 });
    await page.mouse.up();
    expect((await toggle.boundingBox())!.x).toBeLessThan(beforeDrag.x - 100);
    const draggedBounds = (await toggle.boundingBox())!;
    await toggle.focus();
    await page.keyboard.press('ArrowLeft');
    expect((await toggle.boundingBox())!.x).toBe(draggedBounds.x - 12);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    await dock.locator('button.close').click();
    const dialog = dock.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const panelCloseBounds = (await dock
      .locator('button.panel-close')
      .boundingBox())!;
    const panelCrossBounds = (await dock
      .locator('button.panel-close svg')
      .boundingBox())!;
    expect(panelCrossBounds.x + panelCrossBounds.width / 2).toBeCloseTo(
      panelCloseBounds.x + panelCloseBounds.width / 2,
      1,
    );
    expect(panelCrossBounds.y + panelCrossBounds.height / 2).toBeCloseTo(
      panelCloseBounds.y + panelCloseBounds.height / 2,
      1,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(dock.locator('button.close')).toBeFocused();
    await dock.locator('button.close').click();
    await dock.getByLabel(/Smaller floating button|缩小悬浮球/).check();
    expect((await toggle.boundingBox())!.width).toBe(36);
    await mkdir(resolve('docs/evidence/0016'), { recursive: true });
    await dialog.screenshot({
      path: resolve('docs/evidence/0016/page-settings-light.png'),
    });
    await dock.evaluate((node) => {
      (node as HTMLElement).dataset.theme = 'dark';
    });
    await dialog.screenshot({
      path: resolve('docs/evidence/0016/page-settings-dark.png'),
    });
    await dock.evaluate((node) => {
      (node as HTMLElement).dataset.theme = 'light';
    });
    await page.setViewportSize({ width: 450, height: 350 });
    // Viewport changes and the browser's resize event are asynchronous. Wait
    // until the runtime has repositioned the open panel before measuring it.
    await expect
      .poll(async () => {
        const bounds = (await dialog.boundingBox())!;
        return Math.max(
          12 - bounds.x,
          12 - bounds.y,
          bounds.x + bounds.width - (450 - 12),
          bounds.y + bounds.height - (350 - 12),
        );
      })
      .toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    const newMy = context.waitForEvent('page');
    await dock
      .getByRole('button', { name: /Open My page|打开我的页面/ })
      .click();
    const myTab = await newMy;
    await expect(myTab).toHaveURL(/\/my.html$/);
    await myTab.close();
    await page.bringToFront();
    await dock.locator('button.toggle').click();
    await expect
      .poll(() => page.locator('[data-magnet-preview-inline]').count())
      .toBeGreaterThan(0);
    await page.reload();
    await expect(dock).toHaveCount(1);
    await expect(dock.locator('button.toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    await dock.locator('button.toggle').click();
    await expect
      .poll(() => page.locator('[data-magnet-preview-inline]').count())
      .toBeGreaterThan(0);
    await dock.locator('button.close').click();
    await expect(dock.getByRole('dialog')).toBeVisible();
    await dock
      .getByRole('checkbox', { name: 'Hide floating button', exact: true })
      .check();
    await expect(
      dock.getByRole('radio', { name: 'Until the next visit' }),
    ).toBeChecked();
    await dock
      .getByRole('checkbox', { name: 'Hide floating button', exact: true })
      .uncheck();
    await expect(dock.locator('.hide-options')).toBeHidden();
    await expect(dock).toHaveCount(1);
    await dock
      .getByRole('checkbox', { name: 'Hide floating button', exact: true })
      .check();
    await dock
      .getByRole('button', { name: 'Hide floating button', exact: true })
      .click();
    await expect(dock).toHaveCount(0);
    await page.reload();
    await expect(dock).toHaveCount(1);
    // Site/global choices survive navigation and restore only through Settings.
    const settings = await context.newPage();
    const settingsUrl = `chrome-extension://${new URL(worker.url()).host}/my.html#settings`;
    await settings.goto(settingsUrl);
    const otherVisit = await context.newPage();
    await otherVisit.goto(fixtureUrl);
    await expect(otherVisit.locator('magnet-preview-tools')).toHaveCount(1);
    for (const scope of ['site', 'global'] as const) {
      await page.bringToFront();
      await dock.locator('button.close').click();
      await dock
        .getByRole('checkbox', { name: 'Hide floating button', exact: true })
        .check();
      await dock
        .getByRole('radio', {
          name:
            scope === 'site' ? 'Disable on this site' : 'Disable permanently',
          exact: true,
        })
        .check();
      await dock
        .getByRole('button', { name: 'Hide floating button', exact: true })
        .click();
      await expect(dock).toHaveCount(0);
      await expect(otherVisit.locator('magnet-preview-tools')).toHaveCount(0);
      await page.reload();
      await expect(dock).toHaveCount(0);
      const stored = await worker.evaluate(() =>
        chrome.storage.local.get('magnetPreview.pageToolVisibility.v1'),
      );
      expect(stored['magnetPreview.pageToolVisibility.v1']).toEqual({
        schemaVersion: 1,
        globalDisabled: scope === 'global',
        disabledSites: scope === 'site' ? ['http://127.0.0.1/*'] : [],
      });
      if (scope === 'global') {
        await settings.goto(
          `chrome-extension://${new URL(worker.url()).host}/popup.html`,
        );
        await expect(settings.locator('.popup-secondary-button')).toBeEnabled();
        await page.bringToFront();
        const openedSettings = context.waitForEvent('page');
        await settings
          .locator('.popup-secondary-button')
          .evaluate((button: HTMLButtonElement) => button.click());
        const recovery = await openedSettings;
        await expect(recovery).toHaveURL(settingsUrl);
        await expect(
          recovery.getByText('Floating button disabled on all sites', {
            exact: true,
          }),
        ).toBeVisible();
        await expect(dock).toHaveCount(0);
        await recovery.screenshot({
          path: resolve('docs/evidence/0016/disabled-settings.png'),
          fullPage: true,
        });
        await recovery.close();
        await settings.goto(settingsUrl);
      }
      await settings.reload();
      await expect(
        settings.getByRole('heading', { name: 'Settings', exact: true }),
      ).toBeVisible();
      await settings
        .getByRole('button', {
          name: scope === 'site' ? 'Re-enable http://127.0.0.1' : 'Re-enable',
          exact: true,
        })
        .click();
      await expect(
        settings.getByRole('button', { name: /Re-enable/ }),
      ).toHaveCount(0);
      await page.reload();
      await expect(dock).toHaveCount(1);
      await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
      await otherVisit.reload();
      await expect(otherVisit.locator('magnet-preview-tools')).toHaveCount(1);
    }
    await otherVisit.close();
    await settings.close();
    const sessions = await worker.evaluate(() =>
      chrome.storage.session.get(null),
    );
    expect(sessions[`magnetPreview.pageTools.${tabId}`]).toBeTruthy();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    const revokePopup = await context.newPage();
    await revokePopup.addInitScript(
      ({ tabId, fixtureUrl }) => {
        const native = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
          query.active
            ? [{ id: tabId, url: fixtureUrl }]
            : native(query)) as typeof chrome.tabs.query;
      },
      { tabId, fixtureUrl },
    );
    await revokePopup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    );
    await revokePopup.evaluate(() => {
      // The fixture's required host grant cannot be removed. Simulate the
      // successful optional removal while checking unregister and cleanup.
      chrome.permissions.remove = async () => true;
    });
    await revokePopup.locator('.popup-page-options summary').click();
    await revokePopup
      .getByRole('button', { name: 'Stop showing button on this site' })
      .click();
    await expect(
      revokePopup.getByRole('button', {
        name: 'Always show button on this site',
      }),
    ).toBeVisible();
    await expect(dock).toHaveCount(0);
    await page.reload();
    await expect(dock).toHaveCount(0);
    await page.bringToFront();
    const openControl = revokePopup.getByRole('button', {
      name: /Open page preview controls|在页面打开预览工具/,
    });
    await openControl.evaluate((button: HTMLButtonElement) => button.click());
    await expect(dock).toHaveCount(1);
    await dock.locator('button.toggle').click();
    await expect
      .poll(() => page.locator('[data-magnet-preview-inline]').count())
      .toBeGreaterThan(0);
    await page.reload();
    await expect(dock).toHaveCount(0);
    await openControl.evaluate((button: HTMLButtonElement) => button.click());
    await expect(dock).toHaveCount(1);
    await expect(dock.locator('button.toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await dock.locator('button.toggle').click();
    await expect
      .poll(() => page.locator('[data-magnet-preview-inline]').count())
      .toBeGreaterThan(0);
    // Exercise the real action surface: opening tools must reveal the page,
    // rather than leave its dock hidden beneath the toolbar Popup.
    const preferences = await context.newPage();
    await preferences.goto(
      `chrome-extension://${new URL(worker.url()).host}/my.html`,
    );
    await preferences
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await preferences.getByLabel('Language').selectOption('zh_CN');
    await preferences.close();
    await page.bringToFront();
    const cdp = await context.newCDPSession(page);
    const priorTargets = new Set(
      (await cdp.send('Target.getTargets')).targetInfos.map(
        (target: { targetId: string }) => target.targetId,
      ),
    );
    await worker.evaluate(() => chrome.action.openPopup());
    const { targetInfos } = await cdp.send('Target.getTargets');
    const action = targetInfos.find(
      (target: { url: string; targetId: string }) =>
        target.url.endsWith('/popup.html') &&
        !priorTargets.has(target.targetId),
    );
    expect(action).toBeDefined();
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: action!.targetId,
      flatten: false,
    });
    const clicked = new Promise<void>((resolveClick, rejectClick) => {
      const timer = setTimeout(
        () => rejectClick(new Error('Action button did not initialize')),
        5000,
      );
      cdp.on('Target.receivedMessageFromTarget', (event) => {
        if (event.sessionId !== sessionId) return;
        const response = JSON.parse(event.message);
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.result?.exceptionDetails)
          rejectClick(new Error('Action evaluation failed'));
        else resolveClick();
      });
    });
    await cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(async () => { for (let n=0; n<50; n++) { const button = document.querySelector('.popup-secondary-button');
        if (button && !button.disabled) { button.click(); return true; } await new Promise(resolve => setTimeout(resolve, 50)); }
        throw new Error('Action button unavailable'); })()`,
          awaitPromise: true,
          returnByValue: true,
        },
      }),
    });
    await clicked;
    await expect
      .poll(async () =>
        (await cdp.send('Target.getTargets')).targetInfos.some(
          (target: { targetId: string }) =>
            target.targetId === action!.targetId,
        ),
      )
      .toBe(false);
    await expect(dock.getByRole('dialog')).toBeVisible();
    await dock.getByRole('dialog').screenshot({
      path: resolve('docs/evidence/0016/page-settings-zh-light.png'),
    });
    await dock.evaluate((node) => {
      (node as HTMLElement).dataset.theme = 'dark';
    });
    await dock.getByRole('dialog').screenshot({
      path: resolve('docs/evidence/0016/page-settings-zh-dark.png'),
    });
    await dock
      .getByRole('checkbox', { name: '隐藏悬浮球', exact: true })
      .check();
    await dock.getByRole('dialog').screenshot({
      path: resolve('docs/evidence/0016/hide-options-zh-dark.png'),
    });
    await dock.evaluate((node) => {
      (node as HTMLElement).dataset.theme = 'light';
    });
    await dock.getByRole('dialog').screenshot({
      path: resolve('docs/evidence/0016/hide-options-zh-light.png'),
    });
    const linkedSettings = context.waitForEvent('page');
    await dock.locator('.settings-link').click();
    const linked = await linkedSettings;
    await expect(linked).toHaveURL(settingsUrl);
    await expect(
      linked.getByRole('heading', { name: '设置', exact: true }),
    ).toBeVisible();
    await linked.close();
    expect(external).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  }
});
