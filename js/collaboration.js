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
  }

  connect(roomId) {
    this.roomId = roomId;

    try {
      this.channel = new BroadcastChannel(`quickdb_${roomId}`);
      this.channel.onmessage = (event) => this.handleMessage(event.data);
      this.isConnected = true;

      this.announce();
      this.startHeartbeat();
      this.flushOfflineQueue();
      this.notifyStatus('online');

      return true;
    } catch (e) {
      console.error('Failed to connect:', e);
      return false;
    }
  }

  disconnect() {
    if (this.channel) {
      this.send({ type: 'leave', siteId: this.doc.siteId });
      this.channel.close();
      this.channel = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.isConnected = false;
    this.peers.clear();
    this.notifyStatus('offline');
  }

  announce() {
    this.send({
      type: 'join',
      siteId: this.doc.siteId,
      timestamp: Date.now(),
      state: this.doc.getState()
    });
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.send({
        type: 'heartbeat',
        siteId: this.doc.siteId,
        timestamp: Date.now()
      });

      const now = Date.now();
      for (const [siteId, peer] of this.peers) {
        if (now - peer.lastSeen > 10000) {
          this.peers.delete(siteId);
        }
      }
      this.notifyPeerCount();
    }, 3000);
  }

  handleMessage(msg) {
    if (msg.siteId === this.doc.siteId) return;

    switch (msg.type) {
      case 'join':
        this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId });
        if (msg.state) {
          this.mergeRemoteState(msg.state);
        }
        this.send({
          type: 'welcome',
          siteId: this.doc.siteId,
          state: this.doc.getState()
        });
        this.notifyPeerCount();
        break;

      case 'welcome':
        this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId });
        if (msg.state) {
          this.mergeRemoteState(msg.state);
        }
        this.notifyPeerCount();
        break;

      case 'heartbeat':
        this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId });
        break;

      case 'ops':
        this.peers.set(msg.siteId, { lastSeen: Date.now(), siteId: msg.siteId });
        for (const op of msg.ops) {
          this.doc.applyRemoteOp(op);
        }
        break;

      case 'cursor':
        this.cursorPositions.set(msg.siteId, msg.position);
        this.notifyCursors();
        break;

      case 'leave':
        this.peers.delete(msg.siteId);
        this.cursorPositions.delete(msg.siteId);
        this.notifyPeerCount();
        break;
    }
  }

  mergeRemoteState(state) {
    const currentState = this.doc.getState();
    const currentNodeIds = new Set(currentState.nodes.map(n => n.id));
    const currentEdgeIds = new Set(currentState.edges.map(e => e.id));

    for (const node of state.nodes) {
      if (!currentNodeIds.has(node.id)) {
        this.doc.nodes.set(node.id, node);
      }
    }
    for (const edge of state.edges) {
      if (!currentEdgeIds.has(edge.id)) {
        this.doc.edges.set(edge.id, edge);
      }
    }
    if (state.clock) {
      this.doc.vectorClock.merge(state.clock);
    }
    this.doc.notify({ type: 'state_sync' });
  }

  broadcastOps(ops) {
    if (this.isConnected && ops.length > 0) {
      this.send({ type: 'ops', siteId: this.doc.siteId, ops });
    } else {
      this.offlineQueue.push(...ops);
    }
  }

  broadcastCursor(position) {
    if (this.isConnected) {
      this.send({ type: 'cursor', siteId: this.doc.siteId, position });
    }
  }

  flushOfflineQueue() {
    if (this.offlineQueue.length > 0 && this.isConnected) {
      this.send({ type: 'ops', siteId: this.doc.siteId, ops: this.offlineQueue });
      this.offlineQueue = [];
    }
  }

  send(msg) {
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch (e) {
        this.offlineQueue.push(msg);
        this.handleDisconnect();
      }
    }
  }

  handleDisconnect() {
    this.isConnected = false;
    this.notifyStatus('offline');
    this.reconnectTimeout = setTimeout(() => {
      if (this.roomId) {
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

  getPeerCount() {
    return this.peers.size;
  }
}
