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
    const frozen = JSON.parse(JSON.stringify(value));
    if (!this.entries.has(key)) {
      this.entries.set(key, { value: frozen, timestamp: ts, siteId: this.siteId, deleted: false });
    } else {
      const entry = this.entries.get(key);
      entry.value = frozen;
      entry.timestamp = ts;
      entry.siteId = this.siteId;
      entry.deleted = false;
    }
    return { type: 'map_set', key, value: frozen, timestamp: ts, siteId: this.siteId };
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
    return JSON.parse(JSON.stringify(entry.value));
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

    const diff = {};
    for (const key of Object.keys(updates)) {
      if (key === 'id') continue;
      if (key === 'fields') {
        const existingFields = new Map((existing.fields || []).map(f => [f.id || f.name, f]));
        const updatedFields = updates.fields || [];
        const changedFields = [];
        for (const f of updatedFields) {
          const fkey = f.id || f.name;
          const ef = existingFields.get(fkey);
          if (!ef || JSON.stringify(ef) !== JSON.stringify(f)) {
            changedFields.push(f);
          }
        }
        if (changedFields.length > 0) {
          diff.fields = changedFields;
        }
        continue;
      }
      if (JSON.stringify(updates[key]) !== JSON.stringify(existing[key])) {
        diff[key] = updates[key];
      }
    }

    const op = {
      type: 'update_node',
      nodeId,
      updates: JSON.parse(JSON.stringify(diff)),
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
          const nodeData = JSON.parse(JSON.stringify(op.data));
          nodeData.name = this.deduplicateName(nodeData.name, op.nodeId);
          this.nodes.set(op.nodeId, nodeData);
          changed = true;
        }
        break;
      case 'update_node': {
        const existing = this.nodes.get(op.nodeId);
        if (existing) {
          const merged = this.mergeNodeData(existing, op.data, op.updates);
          const serializedBefore = JSON.stringify(existing);
          const serializedAfter = JSON.stringify(merged);
          if (serializedBefore !== serializedAfter) {
            this.nodes.set(op.nodeId, merged);
            changed = true;
          }
        } else {
          this.nodes.set(op.nodeId, JSON.parse(JSON.stringify(op.data)));
          changed = true;
        }
        break;
      }
      case 'remove_node': {
        if (this.nodes.has(op.nodeId)) {
          const entry = this.nodes.entries.get(op.nodeId);
          if (entry && !entry.deleted && op.timestamp >= entry.timestamp) {
            this.nodes.delete(op.nodeId);
            changed = true;
          }
        }
        break;
      }
      case 'add_edge':
        if (!this.edges.has(op.edgeId)) {
          this.edges.set(op.edgeId, JSON.parse(JSON.stringify(op.data)));
          changed = true;
        }
        break;
      case 'update_edge': {
        const existing = this.edges.get(op.edgeId);
        if (existing) {
          const entry = this.edges.entries.get(op.edgeId);
          if (op.timestamp >= entry.timestamp) {
            this.edges.set(op.edgeId, JSON.parse(JSON.stringify(op.data)));
            changed = true;
          }
        } else {
          this.edges.set(op.edgeId, JSON.parse(JSON.stringify(op.data)));
          changed = true;
        }
        break;
      }
      case 'remove_edge': {
        if (this.edges.has(op.edgeId)) {
          const entry = this.edges.entries.get(op.edgeId);
          if (entry && !entry.deleted && op.timestamp >= entry.timestamp) {
            this.edges.delete(op.edgeId);
            changed = true;
          }
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

  mergeNodeData(local, remote, updates) {
    const merged = { ...local };

    if (updates) {
      for (const key of Object.keys(updates)) {
        if (key === 'fields') continue;
        merged[key] = updates[key];
      }
    } else {
      for (const key of Object.keys(remote)) {
        if (key === 'fields' || key === 'id') continue;
        if (key === 'x' || key === 'y' || key === 'width' || key === 'height' || key === 'name') {
          merged[key] = remote[key];
        }
      }
    }

    const changedFields = updates && updates.fields
      ? new Map((updates.fields || []).map(f => [f.id || f.name, f]))
      : null;

    if (changedFields) {
      const localFields = new Map((local.fields || []).map(f => [f.id || f.name, f]));
      const mergedFields = [];
      const seen = new Set();

      for (const [key, localField] of localFields) {
        const changed = changedFields.get(key);
        if (changed) {
          mergedFields.push({ ...localField, ...changed });
        } else {
          mergedFields.push(localField);
        }
        seen.add(key);
      }

      for (const [key, field] of changedFields) {
        if (!seen.has(key)) {
          mergedFields.push(field);
        }
      }

      merged.fields = mergedFields;
    } else if (remote.fields && !updates) {
      const localFields = new Map((local.fields || []).map(f => [f.id || f.name, f]));
      const remoteFields = new Map((remote.fields || []).map(f => [f.id || f.name, f]));
      const mergedFields = [];
      const seen = new Set();

      for (const [key, localField] of localFields) {
        const remoteField = remoteFields.get(key);
        if (remoteField) {
          mergedFields.push({ ...localField, ...remoteField });
        } else {
          mergedFields.push(localField);
        }
        seen.add(key);
      }

      for (const [key, remoteField] of remoteFields) {
        if (!seen.has(key)) {
          mergedFields.push(remoteField);
        }
      }

      merged.fields = mergedFields;
    }

    return merged;
  }

  deduplicateName(name, excludeId) {
    const existingNames = new Set();
    for (const { key, value } of this.nodes.values()) {
      if (key !== excludeId) {
        existingNames.add(value.name);
      }
    }
    if (!existingNames.has(name)) return name;
    let suffix = 1;
    let candidate = `${name}_${suffix}`;
    while (existingNames.has(candidate)) {
      suffix++;
      candidate = `${name}_${suffix}`;
    }
    return candidate;
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
