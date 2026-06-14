export class Collaboration {
  constructor(doc) {
    this.doc = doc;
    this.channel = null;
    this.peers = new Map();
    this.roomId = null;
    this.isConnected = false;
    this.offlineQueue = [];
    this.listeners = new Set();
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.cursorPositions = new Map();
    this.syncSeq = 0;
    this.lastSyncedClock = {};
  }

  connect(roomId) {
    if (this.channel) this.disconnect();
    this.roomId = roomId;

    try {
      this.channel = new BroadcastChannel(`quickdb_room_${roomId}`);
      this.channel.onmessage = (event) => this.handleMessage(event.data);
      this.isConnected = true;

      this.announceJoin();
      this.startHeartbeat();
      this.flushOfflineQueue();
      this.notifyStatus('online');

      return true;
    } catch (e) {
      console.error('Collaboration connect failed:', e);
      return false;
    }
  }

  disconnect() {
    if (this.channel) {
      this.send({ type: 'peer_leave', siteId: this.doc.siteId, timestamp: Date.now() });
      this.channel.close();
      this.channel = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isConnected = false;
    this.peers.clear();
    this.cursorPositions.clear();
    this.notifyStatus('offline');
    this.notifyPeerCount();
  }

  announceJoin() {
    const state = this.doc.getState();
    this.send({
      type: 'peer_join',
      siteId: this.doc.siteId,
      timestamp: Date.now(),
      clock: state.clock,
      state: state
    });
  }

  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      this.send({
        type: 'heartbeat',
        siteId: this.doc.siteId,
        timestamp: Date.now(),
        clock: this.doc.vectorClock.getTimestamp()
      });

      const now = Date.now();
      let changed = false;
      for (const [siteId, peer] of this.peers) {
        if (now - peer.lastSeen > 12000) {
          this.peers.delete(siteId);
          this.cursorPositions.delete(siteId);
          changed = true;
        }
      }
      if (changed) this.notifyPeerCount();
    }, 3000);
  }

  handleMessage(msg) {
    if (!msg || msg.siteId === this.doc.siteId) return;

    switch (msg.type) {
      case 'peer_join':
        this.handlePeerJoin(msg);
        break;

      case 'peer_welcome':
        this.handlePeerWelcome(msg);
        break;

      case 'heartbeat':
        this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId, clock: msg.clock });
        break;

      case 'ops':
        this.handleRemoteOps(msg);
        break;

      case 'cursor_move':
        this.cursorPositions.set(msg.siteId, { x: msg.x, y: msg.y, name: msg.siteId.slice(5, 10) });
        this.notifyCursors();
        break;

      case 'peer_leave':
        this.peers.delete(msg.siteId);
        this.cursorPositions.delete(msg.siteId);
        this.notifyPeerCount();
        break;

      case 'request_state':
        this.sendFullState(msg.siteId);
        break;
    }
  }

  handlePeerJoin(msg) {
    this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId, clock: msg.clock });
    this.notifyPeerCount();

    if (msg.state) {
      this.mergeRemoteState(msg.state);
    }

    const myState = this.doc.getState();
    this.send({
      type: 'peer_welcome',
      siteId: this.doc.siteId,
      targetSiteId: msg.siteId,
      timestamp: Date.now(),
      clock: myState.clock,
      state: myState
    });
  }

  handlePeerWelcome(msg) {
    if (msg.targetSiteId && msg.targetSiteId !== this.doc.siteId) return;

    this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId, clock: msg.clock });
    this.notifyPeerCount();

    if (msg.state) {
      this.mergeRemoteState(msg.state);
    }
  }

  handleRemoteOps(msg) {
    this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId });
    let anyChanged = false;

    for (const op of msg.ops) {
      const changed = this.doc.applyRemoteOp(op);
      if (changed) anyChanged = true;
    }

    if (anyChanged) {
      this.notifyRemoteChange(msg.ops);
    }
  }

  mergeRemoteState(remoteState) {
    const localState = this.doc.getState();
    const localNodeMap = new Map(localState.nodes.map(n => [n.id, n]));
    const localEdgeMap = new Map(localState.edges.map(e => [e.id, e]));
    let changed = false;

    for (const node of remoteState.nodes || []) {
      const local = localNodeMap.get(node.id);
      if (!local) {
        this.doc.nodes.set(node.id, JSON.parse(JSON.stringify(node)));
        changed = true;
      } else {
        const localEntry = this.doc.nodes.entries.get(node.id);
        const remoteTs = remoteState.clock ?
          Object.values(remoteState.clock).reduce((a, b) => a + b, 0) : 0;
        const localTs = localEntry ? localEntry.timestamp : 0;

        if (remoteTs > localTs) {
          const merged = this.mergeNodeFields(local, node);
          this.doc.nodes.set(node.id, merged);
          changed = true;
        } else {
          const merged = this.mergeNodeFields(node, local);
          if (JSON.stringify(merged) !== JSON.stringify(local)) {
            this.doc.nodes.set(node.id, merged);
            changed = true;
          }
        }
      }
    }

    for (const edge of remoteState.edges || []) {
      const local = localEdgeMap.get(edge.id);
      if (!local) {
        this.doc.edges.set(edge.id, JSON.parse(JSON.stringify(edge)));
        changed = true;
      } else {
        const localEntry = this.doc.edges.entries.get(edge.id);
        const remoteTs = remoteState.clock ?
          Object.values(remoteState.clock).reduce((a, b) => a + b, 0) : 0;
        const localTs = localEntry ? localEntry.timestamp : 0;

        if (remoteTs > localTs) {
          this.doc.edges.set(edge.id, JSON.parse(JSON.stringify(edge)));
          changed = true;
        }
      }
    }

    if (remoteState.clock) {
      this.doc.vectorClock.merge(remoteState.clock);
    }

    if (changed) {
      this.doc.notify({ type: 'state_sync', source: 'remote' });
    }
  }

  mergeNodeFields(base, incoming) {
    const merged = { ...base, ...incoming };

    const baseFields = new Map((base.fields || []).map(f => [f.id || f.name, f]));
    const incomingFields = new Map((incoming.fields || []).map(f => [f.id || f.name, f]));

    const mergedFields = [];
    const seen = new Set();

    for (const [key, field] of baseFields) {
      const incomingField = incomingFields.get(key);
      if (incomingField) {
        mergedFields.push({ ...field, ...incomingField });
      } else {
        mergedFields.push(field);
      }
      seen.add(key);
    }

    for (const [key, field] of incomingFields) {
      if (!seen.has(key)) {
        mergedFields.push(field);
      }
    }

    merged.fields = mergedFields;
    return merged;
  }

  broadcastOps(ops) {
    if (!ops || ops.length === 0) return;

    if (this.isConnected) {
      this.send({ type: 'ops', siteId: this.doc.siteId, ops, seq: ++this.syncSeq });
    } else {
      this.offlineQueue.push(...ops);
    }
  }

  broadcastCursor(position) {
    if (!this.isConnected) return;
    this.send({
      type: 'cursor_move',
      siteId: this.doc.siteId,
      x: position.x,
      y: position.y
    });
  }

  sendFullState(targetSiteId) {
    const state = this.doc.getState();
    this.send({
      type: 'peer_welcome',
      siteId: this.doc.siteId,
      targetSiteId,
      timestamp: Date.now(),
      clock: state.clock,
      state: state
    });
  }

  flushOfflineQueue() {
    if (this.offlineQueue.length > 0 && this.isConnected) {
      this.send({
        type: 'ops',
        siteId: this.doc.siteId,
        ops: this.offlineQueue,
        seq: ++this.syncSeq
      });
      this.offlineQueue = [];
    }
  }

  send(msg) {
    if (!this.channel) {
      if (msg.type === 'ops') {
        this.offlineQueue.push(...(msg.ops || []));
      }
      return;
    }
    try {
      this.channel.postMessage(msg);
    } catch (e) {
      console.warn('Send failed, queuing for reconnect:', e);
      if (msg.type === 'ops') {
        this.offlineQueue.push(...(msg.ops || []));
      }
      this.handleDisconnect();
    }
  }

  handleDisconnect() {
    this.isConnected = false;
    this.notifyStatus('syncing');

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.roomId && !this.isConnected) {
        this.connect(this.roomId);
      }
    }, 2000);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyStatus(status) {
    for (const l of this.listeners) {
      try { l({ type: 'status', status }); } catch(e) {}
    }
  }

  notifyPeerCount() {
    for (const l of this.listeners) {
      try { l({ type: 'peers', count: this.peers.size }); } catch(e) {}
    }
  }

  notifyCursors() {
    for (const l of this.listeners) {
      try { l({ type: 'cursors', positions: this.cursorPositions }); } catch(e) {}
    }
  }

  notifyRemoteChange(ops) {
    for (const l of this.listeners) {
      try { l({ type: 'remote_change', ops }); } catch(e) {}
    }
  }

  getPeerCount() {
    return this.peers.size;
  }

  isOnline() {
    return this.isConnected;
  }
}
