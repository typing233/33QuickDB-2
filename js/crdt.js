export class VectorClock {
  constructor(siteId) {
    this.siteId = siteId;
    this.clock = {};
  }

  increment() {
    this.clock[this.siteId] = (this.clock[this.siteId] || 0) + 1;
    return { ...this.clock };
  }

  merge(other) {
    for (const [site, time] of Object.entries(other)) {
      this.clock[site] = Math.max(this.clock[site] || 0, time);
    }
  }

  happensBefore(a, b) {
    let atLeastOne = false;
    for (const site of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[site] || 0) > (b[site] || 0)) return false;
      if ((a[site] || 0) < (b[site] || 0)) atLeastOne = true;
    }
    return atLeastOne;
  }

  concurrent(a, b) {
    return !this.happensBefore(a, b) && !this.happensBefore(b, a);
  }

  getTimestamp() {
    return { ...this.clock };
  }
}

export class LWWRegister {
  constructor(siteId) {
    this.siteId = siteId;
    this.value = null;
    this.timestamp = 0;
    this.writerId = null;
  }

  set(value) {
    this.timestamp = Date.now();
    this.value = value;
    this.writerId = this.siteId;
    return { type: 'set', value, timestamp: this.timestamp, siteId: this.siteId };
  }

  merge(op) {
    if (op.timestamp > this.timestamp ||
        (op.timestamp === this.timestamp && op.siteId > this.writerId)) {
      this.value = op.value;
      this.timestamp = op.timestamp;
      this.writerId = op.siteId;
      return true;
    }
    return false;
  }
}

export class LWWMap {
  constructor(siteId) {
    this.siteId = siteId;
    this.entries = new Map();
  }

  set(key, value) {
    const ts = Date.now();
    if (!this.entries.has(key)) {
      this.entries.set(key, { value, timestamp: ts, siteId: this.siteId, deleted: false });
    } else {
      const entry = this.entries.get(key);
      entry.value = value;
      entry.timestamp = ts;
      entry.siteId = this.siteId;
      entry.deleted = false;
    }
    return { type: 'map_set', key, value, timestamp: ts, siteId: this.siteId };
  }

  delete(key) {
    const ts = Date.now();
    if (this.entries.has(key)) {
      const entry = this.entries.get(key);
      entry.deleted = true;
      entry.timestamp = ts;
      entry.siteId = this.siteId;
    } else {
      this.entries.set(key, { value: null, timestamp: ts, siteId: this.siteId, deleted: true });
    }
    return { type: 'map_delete', key, timestamp: ts, siteId: this.siteId };
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.deleted) return undefined;
    return entry.value;
  }

  has(key) {
    const entry = this.entries.get(key);
    return entry && !entry.deleted;
  }

  values() {
    const result = [];
    for (const [key, entry] of this.entries) {
      if (!entry.deleted) result.push({ key, value: entry.value });
    }
    return result;
  }

  merge(op) {
    const existing = this.entries.get(op.key);
    if (!existing || op.timestamp > existing.timestamp ||
        (op.timestamp === existing.timestamp && op.siteId > existing.siteId)) {
      this.entries.set(op.key, {
        value: op.type === 'map_delete' ? null : op.value,
        timestamp: op.timestamp,
        siteId: op.siteId,
        deleted: op.type === 'map_delete'
      });
      return true;
    }
    return false;
  }
}

export class CRDTDocument {
  constructor(siteId) {
    this.siteId = siteId || this.generateSiteId();
    this.vectorClock = new VectorClock(this.siteId);
    this.nodes = new LWWMap(this.siteId);
    this.edges = new LWWMap(this.siteId);
    this.opLog = [];
    this.pendingOps = [];
    this.listeners = new Set();
  }

  generateSiteId() {
    return 'site_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  addNode(node) {
    const clock = this.vectorClock.increment();
    const op = {
      type: 'add_node',
      nodeId: node.id,
      data: JSON.parse(JSON.stringify(node)),
      clock,
      siteId: this.siteId,
      timestamp: Date.now()
    };
    this.nodes.set(node.id, node);
    this.opLog.push(op);
    this.pendingOps.push(op);
    this.notify(op);
    return op;
  }

  updateNode(nodeId, updates) {
    const existing = this.nodes.get(nodeId);
    if (!existing) return null;
    const clock = this.vectorClock.increment();
    const merged = { ...existing, ...updates };
    const op = {
      type: 'update_node',
      nodeId,
      updates: JSON.parse(JSON.stringify(updates)),
      data: JSON.parse(JSON.stringify(merged)),
      clock,
      siteId: this.siteId,
      timestamp: Date.now()
    };
    this.nodes.set(nodeId, merged);
    this.opLog.push(op);
    this.pendingOps.push(op);
    this.notify(op);
    return op;
  }

  removeNode(nodeId) {
    const clock = this.vectorClock.increment();
    const op = {
      type: 'remove_node',
      nodeId,
      clock,
      siteId: this.siteId,
      timestamp: Date.now()
    };
    this.nodes.delete(nodeId);
    this.opLog.push(op);
    this.pendingOps.push(op);
    this.notify(op);
    return op;
  }

  addEdge(edge) {
    const clock = this.vectorClock.increment();
    const op = {
      type: 'add_edge',
      edgeId: edge.id,
      data: JSON.parse(JSON.stringify(edge)),
      clock,
      siteId: this.siteId,
      timestamp: Date.now()
    };
    this.edges.set(edge.id, edge);
    this.opLog.push(op);
    this.pendingOps.push(op);
    this.notify(op);
    return op;
  }

  updateEdge(edgeId, updates) {
    const existing = this.edges.get(edgeId);
    if (!existing) return null;
    const clock = this.vectorClock.increment();
    const merged = { ...existing, ...updates };
    const op = {
      type: 'update_edge',
      edgeId,
      updates: JSON.parse(JSON.stringify(updates)),
      data: JSON.parse(JSON.stringify(merged)),
      clock,
      siteId: this.siteId,
      timestamp: Date.now()
    };
    this.edges.set(edgeId, merged);
    this.opLog.push(op);
    this.pendingOps.push(op);
    this.notify(op);
    return op;
  }

  removeEdge(edgeId) {
    const clock = this.vectorClock.increment();
    const op = {
      type: 'remove_edge',
      edgeId,
      clock,
      siteId: this.siteId,
      timestamp: Date.now()
    };
    this.edges.delete(edgeId);
    this.opLog.push(op);
    this.pendingOps.push(op);
    this.notify(op);
    return op;
  }

  applyRemoteOp(op) {
    this.vectorClock.merge(op.clock);
    let changed = false;

    switch (op.type) {
      case 'add_node':
        if (!this.nodes.has(op.nodeId)) {
          this.nodes.set(op.nodeId, op.data);
          changed = true;
        }
        break;
      case 'update_node': {
        const existing = this.nodes.get(op.nodeId);
        if (existing) {
          const entry = this.nodes.entries.get(op.nodeId);
          if (op.timestamp >= entry.timestamp) {
            this.nodes.set(op.nodeId, op.data);
            changed = true;
          }
        } else {
          this.nodes.set(op.nodeId, op.data);
          changed = true;
        }
        break;
      }
      case 'remove_node': {
        const entry = this.nodes.entries.get(op.nodeId);
        if (entry && !entry.deleted && op.timestamp >= entry.timestamp) {
          this.nodes.delete(op.nodeId);
          changed = true;
        }
        break;
      }
      case 'add_edge':
        if (!this.edges.has(op.edgeId)) {
          this.edges.set(op.edgeId, op.data);
          changed = true;
        }
        break;
      case 'update_edge': {
        const existing = this.edges.get(op.edgeId);
        if (existing) {
          const entry = this.edges.entries.get(op.edgeId);
          if (op.timestamp >= entry.timestamp) {
            this.edges.set(op.edgeId, op.data);
            changed = true;
          }
        } else {
          this.edges.set(op.edgeId, op.data);
          changed = true;
        }
        break;
      }
      case 'remove_edge': {
        const entry = this.edges.entries.get(op.edgeId);
        if (entry && !entry.deleted && op.timestamp >= entry.timestamp) {
          this.edges.delete(op.edgeId);
          changed = true;
        }
        break;
      }
    }

    if (changed) {
      this.opLog.push(op);
      this.notify(op);
    }
    return changed;
  }

  getPendingOps() {
    const ops = [...this.pendingOps];
    this.pendingOps = [];
    return ops;
  }

  getState() {
    const nodes = [];
    const edges = [];
    for (const { key, value } of this.nodes.values()) nodes.push(value);
    for (const { key, value } of this.edges.values()) edges.push(value);
    return { nodes, edges, siteId: this.siteId, clock: this.vectorClock.getTimestamp() };
  }

  loadState(state) {
    if (state.clock) this.vectorClock.merge(state.clock);
    for (const node of state.nodes || []) {
      this.nodes.set(node.id, node);
    }
    for (const edge of state.edges || []) {
      this.edges.set(edge.id, edge);
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(op) {
    for (const listener of this.listeners) {
      try { listener(op); } catch(e) { console.error(e); }
    }
  }
}
