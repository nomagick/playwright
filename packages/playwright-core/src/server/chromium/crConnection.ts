/**
 * Copyright 2017 Google Inc. All rights reserved.
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

import { debugLogger } from '@utils/debugLogger';
import { assert } from '@isomorphic/assert';
import { eventsHelper } from '@utils/eventsHelper';
import { helper } from '../helper';
import { ProtocolError } from '../protocolError';
import { SdkObject } from '../instrumentation';

import type { RegisteredListener } from '@utils/eventsHelper';
import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from '../transport';
import type { Protocol } from './protocol';
import type { RecentLogsCollector } from '@utils/debugLogger';
import type { ProtocolLogger } from '../types';
import type { Progress } from '../progress';


export const ConnectionEvents = {
  Disconnected: Symbol('ConnectionEvents.Disconnected')
};

export type ConnectionEventMap = {
  [ConnectionEvents.Disconnected]: [];
};

// CRPlaywright uses this special id to issue Browser.close command which we
// should ignore.
export const kBrowserCloseMessageId = -9999;

export class CRConnection extends SdkObject {
  private _lastId = 0;
  private readonly _transport: ConnectionTransport;
  readonly _sessions = new Map<string, CRSession>();
  private readonly _protocolLogger: ProtocolLogger;
  private readonly _browserLogsCollector: RecentLogsCollector;
  _browserDisconnectedLogs: string | undefined;
  readonly rootSession: CRSession;
  _closed = false;

  constructor(parent: SdkObject, transport: ConnectionTransport, protocolLogger: ProtocolLogger, browserLogsCollector: RecentLogsCollector) {
    super(parent, 'cr-connection');
    this.setMaxListeners(0);
    this._transport = transport;
    this._protocolLogger = protocolLogger;
    this._browserLogsCollector = browserLogsCollector;
    this.rootSession = new CRSession(this, null, '');
    this._sessions.set('', this.rootSession);
    this._transport.onmessage = this._onMessage.bind(this);
    // onclose should be set last, since it can be immediately called.
    this._transport.onclose = this._onClose.bind(this);
  }

  _rawSend(sessionId: string, method: string, params: any): number {
    const id = ++this._lastId;
    const message: ProtocolRequest = { id, method, params };
    if (sessionId)
      message.sessionId = sessionId;
    this._protocolLogger('send', message);
    this._transport.send(message);
    return id;
  }

  async _onMessage(message: ProtocolResponse) {
    this._protocolLogger('receive', message);
    if (message.id === kBrowserCloseMessageId)
      return;
    const session = this._sessions.get(message.sessionId || '');
    if (session)
      session._onMessage(message);
  }

  _onClose(reason?: string) {
    this._closed = true;
    this._transport.onmessage = undefined;
    this._transport.onclose = undefined;
    this._browserDisconnectedLogs = helper.formatBrowserLogs(this._browserLogsCollector.recentLogs(), reason);
    this.rootSession.dispose();
    Promise.resolve().then(() => this.emit(ConnectionEvents.Disconnected));
  }

  close() {
    if (!this._closed)
      this._transport.close();
  }

  async createBrowserSession(): Promise<CDPSession> {
    const { sessionId } = await this.rootSession.send('Target.attachToBrowserTarget');
    return new CDPSession(this.rootSession, sessionId);
  }
}

type SessionEventListener = (method: string, params?: Object) => void;

// rebrowser-patches: isolated world used to look up main-world context ids; one random name per process
const rebrowserLookupWorldName = [...Array(Math.floor(Math.random() * (10 + 1)) + 10)].map(() => Math.random().toString(36)[2]).join('');
let rebrowserFallbackWarned = false;

export class CRSession extends SdkObject<Protocol.EventMap & ConnectionEventMap> {
  private readonly _connection: CRConnection;
  private _eventListener?: SessionEventListener;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: ProtocolError) => void, error: ProtocolError }>();
  private readonly _sessionId: string;
  private readonly _parentSession: CRSession | null;
  private _crashed: boolean = false;
  private _closed = false;

  constructor(connection: CRConnection, parentSession: CRSession | null, sessionId: string, eventListener?: SessionEventListener) {
    super(connection, 'cr-session');
    this.setMaxListeners(0);
    this._connection = connection;
    this._parentSession = parentSession;
    this._sessionId = sessionId;
    this._eventListener = eventListener;
  }

  _markAsCrashed() {
    this._crashed = true;
    this._rejectPendingCallbacks(`Page crashed.`);
  }

  createChildSession(sessionId: string, eventListener?: SessionEventListener): CRSession {
    const session = new CRSession(this._connection, this, sessionId, eventListener);
    this._connection._sessions.set(sessionId, session);
    return session;
  }

  async send<T extends keyof Protocol.CommandParameters>(
    method: T,
    params?: Protocol.CommandParameters[T]
  ): Promise<Protocol.CommandReturnValues[T]> {
    if (this._crashed || this._closed || this._connection._closed || this._connection._browserDisconnectedLogs)
      throw new ProtocolError(this._crashed ? 'crashed' : 'closed', undefined, this._connection._browserDisconnectedLogs);
    const id = this._connection._rawSend(this._sessionId, method, params);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error: new ProtocolError('error', method) });
    });
  }

  _sendMayFail<T extends keyof Protocol.CommandParameters>(method: T, params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T] | void> {
    return this.send(method, params).catch((error: ProtocolError) => debugLogger.log('error', error));
  }

  _onMessage(object: ProtocolResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        callback.error.setMessage(object.error.message);
        callback.reject(callback.error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id && object.error?.code === -32001) {
      // Message to a closed session, just ignore it.
    } else {
      assert(!object.id, object?.error?.message || undefined);
      Promise.resolve().then(() => {
        if (this._eventListener)
          this._eventListener(object.method!, object.params);
        (this.emit as any)(object.method as any, object.params);
      });
    }
  }

  async detach() {
    if (this._closed)
      throw new Error(`Session already detached. Most likely the page has been closed.`);
    if (!this._parentSession)
      throw new Error('Root session cannot be closed');
    // Ideally, detaching should resume any target, but there is a bug in the backend,
    // so we must Runtime.runIfWaitingForDebugger first.
    await this._sendMayFail('Runtime.runIfWaitingForDebugger');
    await this._parentSession.send('Target.detachFromTarget', { sessionId: this._sessionId });
    this.dispose();
  }

  dispose() {
    this._closed = true;
    this._connection._sessions.delete(this._sessionId);
    this._rejectPendingCallbacks(`Internal server error, session closed.`);
  }

  private _rejectPendingCallbacks(message: string) {
    for (const callback of this._callbacks.values()) {
      callback.error.setMessage(message);
      callback.error.type = this._crashed ? 'crashed' : 'closed';
      callback.error.logs = this._connection._browserDisconnectedLogs;
      callback.reject(callback.error);
    }
    this._callbacks.clear();
  }

  async __re__emitExecutionContext({
    world,
    targetId,
    frame = null
  }: any) {
    const fixMode = process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] || 'addBinding';
    // the name Playwright expects for its utility world (see CRPage.utilityWorldName), workers have no utility world
    const utilityWorldName = frame?._page?.delegate?.utilityWorldName || 'util';
    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][crSession] targetId = ${targetId}, world = ${world}, frame = ${frame ? 'Y' : 'N'}, fixMode = ${fixMode}`);

    let contextPayload;
    if (world === 'utility') {
      // both modes: a real isolated world with the utility name
      const contextId = await this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: utilityWorldName });
      contextPayload = { id: contextId, name: utilityWorldName, auxData: { frameId: targetId, isDefault: false } };
    } else if (fixMode === 'alwaysIsolated' && frame) {
      // main world requested: give an isolated world that looks like the main one
      const contextId = await this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: utilityWorldName });
      contextPayload = { id: contextId, name: '', auxData: { frameId: targetId, isDefault: true } };
    } else {
      // addBinding mode, and workers in every mode (workers have no isolated worlds)
      const contextId = await this.__re__getMainWorld({ client: this, frameId: targetId, isWorker: frame === null });
      contextPayload = { id: contextId, name: '', auxData: { frameId: targetId, isDefault: true } };
    }
    if (!contextPayload.id)
      throw new Error('[rebrowser-patches] cannot get execution context id');

    this.emit('Runtime.executionContextCreated', {
      context: contextPayload as any
    });
  }
  async __re__getMainWorld({ client, frameId, isWorker = false }: any) {
    // rebrowser-patches: learn the main world's context id without running anything in the page, so there is
    // nothing for page scripts to notice. Only if that fails (e.g. Chrome changes its object id format), fall back to
    // the binding handshake.
    try {
      const contextId = await this.__re__getMainWorldIdByObject({ client, frameId, isWorker });
      if (contextId)
        return contextId;
    } catch (error) {
      process.env['REBROWSER_PATCHES_DEBUG'] && console.log('[rebrowser-patches][getMainWorld] object lookup failed, using a binding:', error);
    }
    if (!rebrowserFallbackWarned) {
      rebrowserFallbackWarned = true;
      console.warn('[rebrowser-patches] could not look up the page\'s context id without touching the page; falling back to a binding handshake that page scripts can notice. Please report this with your Chrome version. REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated avoids it.');
    }
    return this.__re__getMainWorldByBinding({ client, frameId, isWorker });
  }
  // A worker evaluates `this` in its only context. A frame reads `document` in an isolated world and resolves that
  // node again without a context, which lands in the frame's main world. Either way the remote object id is
  // "<isolate>.<contextId>.<id>".
  async __re__getMainWorldIdByObject({ client, frameId, isWorker }: any) {
    const objectGroup = 'g' + Math.random().toString(36).slice(2);
    let objectId: string | undefined;
    try {
      if (isWorker) {
        objectId = (await client.send('Runtime.evaluate', { expression: 'this', objectGroup })).result.objectId;
      } else {
        const { executionContextId } = await client.send('Page.createIsolatedWorld', { frameId, worldName: rebrowserLookupWorldName, grantUniveralAccess: true });
        const { result } = await client.send('Runtime.evaluate', { expression: 'document', contextId: executionContextId, objectGroup });
        const { node } = await client.send('DOM.describeNode', { objectId: result.objectId });
        objectId = (await client.send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup })).object.objectId;
      }
    } finally {
      client.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
    }
    const match = /^-?\d+\.(\d+)\.\d+$/.exec(objectId || '');
    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][getMainWorldIdByObject] frameId = ${frameId}, objectId = ${objectId}`);
    return match ? Number(match[1]) : undefined;
  }
  async __re__getMainWorldByBinding({ client, frameId, isWorker = false }: any) {
    let contextId: any;
    let identifier: any;

    // random name to make it harder to detect for any 3rd party script by watching window object and events
    const randomName = [...Array(Math.floor(Math.random() * (10 + 1)) + 10)].map(() => Math.random().toString(36)[2]).join('');
    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][getMainWorld] binding name = ${randomName}`);

    // add the binding
    await client.send('Runtime.addBinding', {
      name: randomName,
    });

    // listen for 'Runtime.bindingCalled' event
    const bindingCalledHandler = ({ name, payload, executionContextId }: any) => {
      process.env['REBROWSER_PATCHES_DEBUG'] && console.log('[rebrowser-patches][bindingCalledHandler]', {
        name,
        payload,
        executionContextId
      });
      if (contextId > 0) {
        // already acquired the id
        return;
      }
      if (name !== randomName) {
        // ignore irrelevant bindings
        return;
      }
      if (payload !== frameId) {
        // ignore irrelevant frames
        return;
      }
      contextId = executionContextId;
      // remove this listener
      client.off('Runtime.bindingCalled', bindingCalledHandler);
    };
    client.on('Runtime.bindingCalled', bindingCalledHandler);

    if (isWorker) {
      // workers don't support `Page.addScriptToEvaluateOnNewDocument` and `Page.createIsolatedWorld`, but there are no iframes inside of them, so it's safe to just use Runtime.evaluate
      await client.send('Runtime.evaluate', {
        expression: `this['${randomName}']('${frameId}')`,
      });
    } else {
      // we could call the binding right from `addScriptToEvaluateOnNewDocument`, but this way it will be called in all existing frames and it's hard to distinguish children from the parent
      ({ identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', {
        // use `window`, not `self`: pages can reassign `self` (or make it throw, e.g. LavaMoat scuttling), `window` is unforgeable
        source: `document.addEventListener('${randomName}', (e) => window['${randomName}'](e.detail.frameId))`,
        runImmediately: true,
      }));

      // create new isolated world for this frame
      const createIsolatedWorldResult = await client.send('Page.createIsolatedWorld', {
        frameId,
        // use randomName for worldName to distinguish from normal utility world
        worldName: randomName,
        grantUniveralAccess: true,
      });

      // emit event in the specific frame from the isolated world
      await client.send('Runtime.evaluate', {
        expression: `document.dispatchEvent(new CustomEvent('${randomName}', { detail: { frameId: '${frameId}' } }))`,
        contextId: createIsolatedWorldResult.executionContextId,
      });
    }

    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][getMainWorld] result:`, { contextId });
    // don't leave the handshake behind: a native function with a random name on the global object is easy to spot
    client.send('Runtime.removeBinding', { name: randomName }).catch(() => {});
    if (contextId)
      client.send('Runtime.evaluate', { expression: `delete this['${randomName}']`, contextId }).catch(() => {});
    if (identifier)
      client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
    return contextId;
  }
  async __re__getIsolatedWorld({ client, frameId, worldName }: any) {
    const createIsolatedWorldResult = await client.send('Page.createIsolatedWorld', {
      frameId,
      worldName,
      grantUniveralAccess: true,
    });
    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][getIsolatedWorld] result:`, createIsolatedWorldResult);
    return createIsolatedWorldResult.executionContextId;
  }
}

export class CDPSession extends SdkObject {
  static Events = {
    Event: 'event',
    Closed: 'close',
  };

  private _session: CRSession;
  private _listeners: RegisteredListener[] = [];

  constructor(parentSession: CRSession, sessionId: string) {
    super(parentSession, 'cdp-session');
    this._session = parentSession.createChildSession(sessionId, (method, params) => this.emit(CDPSession.Events.Event, { method, params }));
    this._listeners = [eventsHelper.addEventListener(parentSession, 'Target.detachedFromTarget', (event: Protocol.Target.detachedFromTargetPayload) => {
      if (event.sessionId === sessionId)
        this._onClose();
    })];
  }

  async send(progress: Progress, method: string, params?: any) {
    return await progress.race(this._send(method, params));
  }

  async detach(progress: Progress) {
    return await progress.race(this._session.detach());
  }

  private async _send(method: string, params?: any) {
    return await this._session.send(method as any, params);
  }

  async attachToTarget(targetId: string) {
    const { sessionId } = await this._send('Target.attachToTarget', { targetId, flatten: true });
    return new CDPSession(this._session, sessionId);
  }

  private _onClose() {
    eventsHelper.removeEventListeners(this._listeners);
    this._session.dispose();
    this.emit(CDPSession.Events.Closed);
  }
}
