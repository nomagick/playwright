/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { browserTest as it, expect } from '../config/browserTest';
import { attachFrame } from '../config/utils';
import { chromiumVersionLessThan } from '../config/utils';

it('should work', async ({ browser, server }) => {
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Mozilla');
    await context.close();
  }
  {
    const context = await browser.newContext({ userAgent: 'foobar' });
    const page = await context.newPage();
    const [request] = await Promise.all([
      server.waitForRequest('/empty.html'),
      page.goto(server.EMPTY_PAGE),
    ]);
    expect(request.headers['user-agent']).toBe('foobar');
    await context.close();
  }
});

it('should work for subframes', async ({ browser, server }) => {
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Mozilla');
    await context.close();
  }
  {
    const context = await browser.newContext({ userAgent: 'foobar' });
    const page = await context.newPage();
    const [request] = await Promise.all([
      server.waitForRequest('/empty.html'),
      attachFrame(page, 'frame1', server.EMPTY_PAGE),
    ]);
    expect(request.headers['user-agent']).toBe('foobar');
    await context.close();
  }
});

it('should emulate device user-agent', async ({ browser, server, playwright }) => {
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.PREFIX + '/mobile.html');
    expect(await page.evaluate(() => navigator.userAgent)).not.toContain('iPhone');
    await context.close();
  }
  {
    const context = await browser.newContext({ userAgent: playwright.devices['iPhone 6'].userAgent });
    const page = await context.newPage();
    await page.goto(server.PREFIX + '/mobile.html');
    expect(await page.evaluate(() => navigator.userAgent)).toContain('iPhone');
    await context.close();
  }
});

it('should make a copy of default options', async ({ browser, server }) => {
  const options = { userAgent: 'foobar' };
  const context = await browser.newContext(options);
  options.userAgent = 'wrong';
  const page = await context.newPage();
  const [request] = await Promise.all([
    server.waitForRequest('/empty.html'),
    page.goto(server.EMPTY_PAGE),
  ]);
  expect(request.headers['user-agent']).toBe('foobar');
  await context.close();
});

it('custom user agent for download', async ({ server, contextFactory, browserVersion, browserName }) => {
  it.info().annotations.push({ type: 'issue', description: 'https://github.com/microsoft/playwright/issues/22843' });
  it.skip(browserName === 'chromium' && chromiumVersionLessThan(browserVersion, '116.0.0.0'), 'https://chromium-review.googlesource.com/c/chromium/src/+/4554578');

  server.setRoute('/download', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.end(`Hello world`);
  });

  const context = await contextFactory({ userAgent: 'MyCustomUA' });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  await page.setContent(`<a id="download" download="name" href="/download">Download</a>`);
  const serverRequest = server.waitForRequest('/download');
  page.click('#download').catch(e => {});
  const req = await serverRequest;
  expect(req.headers['user-agent']).toBe('MyCustomUA');
});

it('should work for navigator.userAgentData and sec-ch-ua headers', async ({ playwright, browserName, browser, server }) => {
  it.skip(browserName !== 'chromium', 'This API is Chromium-only');

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const [request] = await Promise.all([
      server.waitForRequest('/empty.html'),
      page.goto(server.EMPTY_PAGE),
    ]);
    expect.soft(request.headers['sec-ch-ua']).toContain(`"Chromium"`);
    expect.soft(request.headers['sec-ch-ua-mobile']).toBe(`?0`);
    expect.soft(request.headers['sec-ch-ua-platform']).toBeTruthy();
    expect.soft(await page.evaluate(() => (window.navigator as any).userAgentData.toJSON())).toEqual(
        expect.objectContaining({ mobile: false })
    );
    await context.close();
  }

  {
    const context = await browser.newContext(playwright.devices['Pixel 7']);
    const page = await context.newPage();
    const [request] = await Promise.all([
      server.waitForRequest('/empty.html'),
      page.goto(server.EMPTY_PAGE),
    ]);
    expect.soft(request.headers['sec-ch-ua']).toContain(`"Chromium"`);
    expect.soft(request.headers['sec-ch-ua-mobile']).toBe(`?1`);
    expect.soft(request.headers['sec-ch-ua-platform']).toBe(`"Android"`);
    expect.soft(await page.evaluate(() => (window.navigator as any).userAgentData.toJSON())).toEqual(
        expect.objectContaining({ mobile: true, platform: 'Android' })
    );
    await context.close();
  }
});

const kHighEntropyHints = ['architecture', 'bitness', 'brands', 'formFactors', 'fullVersionList', 'mobile', 'model', 'platform', 'platformVersion', 'uaFullVersion', 'wow64'];

it('should report userAgentMetadata sampled from getHighEntropyValues as is', async ({ browserName, browser, server }) => {
  it.skip(browserName !== 'chromium', 'This API is Chromium-only');

  const probe = await browser.newPage();
  await probe.goto(server.EMPTY_PAGE);
  const sampled = await probe.evaluate(hints => (navigator as any).userAgentData.getHighEntropyValues(hints), kHighEntropyHints);
  await probe.close();
  const rename = (list: { brand: string, version: string }[]) => list.map(b => ({ ...b, brand: b.brand === 'Chromium' ? b.brand : 'Some Brand' }));
  const userAgentMetadata = { ...sampled, brands: rename(sampled.brands), fullVersionList: rename(sampled.fullVersionList), platform: 'Linux', platformVersion: '6.8.0', architecture: 'x86', bitness: '64' };

  const context = await browser.newContext({ userAgent: 'foobar', userAgentMetadata });
  const page = await context.newPage();
  const [request] = await Promise.all([
    server.waitForRequest('/empty.html'),
    page.goto(server.EMPTY_PAGE),
  ]);
  expect(request.headers['sec-ch-ua']).toContain(`"Some Brand"`);
  expect(request.headers['sec-ch-ua-platform']).toBe(`"Linux"`);
  expect(await page.evaluate(hints => (navigator as any).userAgentData.getHighEntropyValues(hints), kHighEntropyHints)).toEqual(userAgentMetadata);

  server.setRoute('/hev-worker.js', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(`navigator.userAgentData.getHighEntropyValues(${JSON.stringify(kHighEntropyHints)}).then(v => postMessage(v));`);
  });
  expect(await page.evaluate(() => new Promise(r => {
    const worker = new Worker('/hev-worker.js');
    worker.onmessage = e => r(e.data);
  }))).toEqual(userAgentMetadata);
  await context.close();
});

it('should derive the userAgentMetadata fields that are not given from userAgent', async ({ browserName, browser, server }) => {
  it.skip(browserName !== 'chromium', 'This API is Chromium-only');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    userAgentMetadata: { brands: [{ brand: 'Some Brand', version: '140' }] },
  });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  expect(await page.evaluate(() => (navigator as any).userAgentData.toJSON())).toEqual({
    brands: [{ brand: 'Some Brand', version: '140' }],
    mobile: false,
    platform: 'Windows',
  });
  await context.close();
});

it('should keep the brands in workers when only userAgent is set', async ({ browserName, browser, server }) => {
  it.skip(browserName !== 'chromium', 'This API is Chromium-only');

  server.setRoute('/brands-worker.js', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(`postMessage(navigator.userAgentData.toJSON());`);
  });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  const pageData = await page.evaluate(() => (navigator as any).userAgentData.toJSON());
  expect(pageData.brands.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => new Promise(r => {
    new Worker('/brands-worker.js').onmessage = e => r(e.data);
  }))).toEqual(pageData);
  await context.close();
});

it('should throw for userAgentMetadata without userAgent', async ({ browser }) => {
  const error = await browser.newContext({ userAgentMetadata: { platform: 'Linux' } }).catch(e => e);
  expect(error.message).toContain('"userAgentMetadata" option requires "userAgent"');
});

it('should emulate the context in dedicated, shared and service workers', async ({ browserName, browser, server }) => {
  it.skip(browserName !== 'chromium', 'Worker emulation is Chromium-only');

  const read = `(async () => ({
    userAgent: navigator.userAgent,
    languages: navigator.languages,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgentData: await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList', 'platform']),
  }))()`;
  const script = (body: string) => (req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(body);
  };
  server.setRoute('/emulation-worker.js', script(`${read}.then(v => postMessage(v));`));
  server.setRoute('/emulation-nested-worker.js', script(`new Worker('/emulation-worker.js').onmessage = e => postMessage(e.data);`));
  server.setRoute('/emulation-shared-worker.js', script(`onconnect = e => ${read}.then(v => e.ports[0].postMessage(v));`));
  server.setRoute('/emulation-service-worker.js', script(`
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('message', e => ${read}.then(v => e.source.postMessage(v)));
  `));

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    userAgentMetadata: {
      brands: [{ brand: 'Some Brand', version: '140' }],
      fullVersionList: [{ brand: 'Some Brand', version: '140.0.1.2' }],
    },
    locale: 'de-DE',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  const values = await page.evaluate(async read => {
    const fromWorker = (url: string) => new Promise(r => {
      new Worker(url).onmessage = e => r(e.data);
    });
    const shared = new SharedWorker('/emulation-shared-worker.js');
    const registration = await navigator.serviceWorker.register('/emulation-service-worker.js');
    const serviceWorker = registration.installing || registration.waiting || registration.active;
    return {
      page: await eval(read),
      worker: await fromWorker('/emulation-worker.js'),
      blobWorker: await fromWorker(URL.createObjectURL(new Blob([`${read}.then(v => postMessage(v));`]))),
      nestedWorker: await fromWorker('/emulation-nested-worker.js'),
      sharedWorker: await new Promise(r => shared.port.onmessage = e => r(e.data)),
      serviceWorker: await new Promise(r => {
        navigator.serviceWorker.onmessage = e => r(e.data);
        serviceWorker.postMessage('read');
      }),
    };
  }, read);

  expect(values.page).toEqual({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    languages: ['de-DE'],
    locale: 'de-DE',
    timeZone: 'Asia/Tokyo',
    userAgentData: {
      brands: [{ brand: 'Some Brand', version: '140' }],
      fullVersionList: [{ brand: 'Some Brand', version: '140.0.1.2' }],
      mobile: false,
      platform: 'Linux',
    },
  });
  expect(values.worker).toEqual(values.page);
  expect(values.blobWorker).toEqual(values.page);
  expect(values.nestedWorker).toEqual(values.page);
  // Chrome sets navigator.userAgent of shared and service workers when it starts them, from the browser's default.
  const { userAgent, ...rest } = values.page;
  expect(values.sharedWorker).toEqual(expect.objectContaining(rest));
  expect(values.serviceWorker).toEqual(expect.objectContaining(rest));
  await context.close();
});
