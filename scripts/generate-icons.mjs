/* global console */
// Rasterize the repository-owned vector mark with the existing dev browser.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve('public/icons/mark.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${source}`,
  );
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({
      path: resolve(`public/icons/icon-${size}.png`),
      omitBackground: true,
    });
  }
  console.log(
    'Generated four local PNG icon sizes from the shared vector mark.',
  );
} finally {
  await browser.close();
}
