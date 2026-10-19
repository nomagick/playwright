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

import { test as it, expect } from '@playwright/test';
import { utils } from '../../../packages/playwright-core/lib/coreBundle';

const { RecentLogsCollector, kMaxRecentLogLength } = utils;

it('should keep short messages verbatim', () => {
  const collector = new RecentLogsCollector();
  const messages = ['[pid=1][err] hello', '', 'ünïcödé 😀', 'x'.repeat(kMaxRecentLogLength)];
  for (const message of messages)
    collector.log(message);
  expect(collector.recentLogs()).toEqual(messages);
});

it('should truncate long messages with a marker', () => {
  const collector = new RecentLogsCollector();
  const message = '[pid=1][err] ' + 'x'.repeat(10 * 1024 * 1024);
  collector.log(message);
  const [stored] = collector.recentLogs();
  const truncated = message.length - kMaxRecentLogLength;
  expect(stored).toBe(message.substring(0, kMaxRecentLogLength) + `... [${truncated} chars truncated]`);
});

it('should not split a surrogate pair when truncating', () => {
  const collector = new RecentLogsCollector();
  const message = 'x'.repeat(kMaxRecentLogLength - 1) + '😀' + 'y'.repeat(10);
  collector.log(message);
  const [stored] = collector.recentLogs();
  expect(stored).toBe('x'.repeat(kMaxRecentLogLength - 1) + `... [12 chars truncated]`);
});

it('should pass truncated messages to listeners', () => {
  const collector = new RecentLogsCollector();
  const early = 'DevTools listening on ws://early' + ' '.repeat(kMaxRecentLogLength);
  collector.log(early);
  const received: string[] = [];
  collector.onMessage(message => received.push(message));
  collector.log('DevTools listening on ws://late');
  expect(received).toEqual([
    early.substring(0, kMaxRecentLogLength) + '... [32 chars truncated]',
    'DevTools listening on ws://late',
  ]);
});

it('should keep at most 150 recent logs', () => {
  const collector = new RecentLogsCollector();
  for (let i = 0; i < 1000; i++) {
    collector.log(`line ${i}`);
    const logs = collector.recentLogs();
    expect(logs.length).toBe(Math.min(i + 1, 150));
    expect(logs[logs.length - 1]).toBe(`line ${i}`);
  }
  expect(collector.recentLogs()[0]).toBe('line 850');
});
