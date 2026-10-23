/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { playwrightTest as it, expect } from '../../config/browserTest';

import type { Page } from 'playwright-core';

// Console messages come from the Runtime domain, so they only arrive when Runtime.enable was sent.
async function consoleMessagesSeen(page: Page): Promise<string[]> {
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.evaluate(() => console.log('hello'));
  await page.waitForTimeout(200);
  return messages;
}

// Globals that would give the automation away, as a page script would look for them.
function automationGlobals(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.getOwnPropertyNames(window).filter(name => name.startsWith('__playwright')));
}

it('should leave contexts unpatched by default', async ({ browser, server }) => {
  const context = await browser.newContext();
  await context.exposeBinding('add', (_source, a: number, b: number) => a + b);
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  expect(await consoleMessagesSeen(page)).toEqual(['hello']);
  expect(await page.evaluate(() => (window as any).add(2, 3))).toBe(5);
  expect(await automationGlobals(page)).toContain('__playwright__binding__');
  await context.close();
});

it('should patch only the contexts that ask for it', async ({ browser, server }) => {
  const patched = await browser.newContext({ reBrowserPatch: true });
  const plain = await browser.newContext();
  const patchedPage = await patched.newPage();
  const plainPage = await plain.newPage();
  await patchedPage.goto(server.EMPTY_PAGE);
  await plainPage.goto(server.EMPTY_PAGE);
  expect(await consoleMessagesSeen(patchedPage)).toEqual([]);
  expect(await consoleMessagesSeen(plainPage)).toEqual(['hello']);
  await patched.close();
  await plain.close();
});

it('should keep evaluate, init scripts and bindings working in a patched context', async ({ browser, server }) => {
  const context = await browser.newContext({ reBrowserPatch: true });
  await context.addInitScript(() => (window as any).fromInitScript = 42);
  await context.exposeBinding('add', (_source, a: number, b: number) => a + b);
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  await page.evaluate(() => (window as any).fromPage = 'main world');
  expect(await page.evaluate(() => [(window as any).fromInitScript, (window as any).fromPage])).toEqual([42, 'main world']);
  expect(await page.evaluate(() => (window as any).add(2, 3))).toBe(5);
  expect(await automationGlobals(page)).toEqual([]);
  await page.setContent('<div>patched content</div>');
  expect(await page.textContent('div')).toBe('patched content');
  await context.close();
});

it('should keep bindings working across navigations in a patched context', async ({ browser, server }) => {
  const context = await browser.newContext({ reBrowserPatch: true });
  await context.exposeBinding('add', (_source, a: number, b: number) => a + b);
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  expect(await page.evaluate(() => (window as any).add(1, 1))).toBe(2);
  await page.goto(server.CROSS_PROCESS_PREFIX + '/empty.html');
  expect(await page.evaluate(() => (window as any).add(2, 2))).toBe(4);
  await context.close();
});

it('should report navigator.webdriver unless the browser was launched with reBrowserPatch', async ({ browserType, browser, server, mode }) => {
  it.skip(mode !== 'default', 'launches its own browser');
  const plainPage = await browser.newPage();
  await plainPage.goto(server.EMPTY_PAGE);
  expect(await plainPage.evaluate(() => navigator.webdriver)).toBe(true);
  await plainPage.close();

  const patchedBrowser = await browserType.launch({ reBrowserPatch: true });
  const page = await patchedBrowser.newPage();
  await page.goto(server.EMPTY_PAGE);
  expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  // the launch option alone leaves the context unpatched
  expect(await consoleMessagesSeen(page)).toEqual(['hello']);
  await patchedBrowser.close();
});

it('should apply both patches to a persistent context', async ({ launchPersistent, server, mode }) => {
  it.skip(mode !== 'default', 'launches its own browser');
  const { page } = await launchPersistent({ reBrowserPatch: true });
  await page.goto(server.EMPTY_PAGE);
  expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  expect(await consoleMessagesSeen(page)).toEqual([]);
});
