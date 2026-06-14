export function exportToJSON(doc, versionControl) {
  const state = doc.getState();
  const branches = versionControl.getBranches();
  const commits = versionControl.commits;

  return {
    version: '1.0.0',
    format: 'full',
    exportedAt: new Date().toISOString(),
    schema: {
      nodes: state.nodes,
      edges: state.edges
    },
    metadata: {
      siteId: doc.siteId,
      clock: doc.vectorClock.getTimestamp(),
      opLogLength: doc.opLog.length
    },
    versionControl: {
      currentBranch: versionControl.currentBranch,
      branches: branches.map(b => ({ name: b.name, head: b.head, created: b.created })),
      commits: commits.map(c => ({
        id: c.id,
        branch: c.branch,
        message: c.message,
        timestamp: c.timestamp,
        parent: c.parent
      }))
    }
  };
}

export function exportIncremental(doc, lastExportClock) {
  const state = doc.getState();

  const newOps = doc.opLog.filter(op => {
    if (!lastExportClock || Object.keys(lastExportClock).length === 0) return true;
    for (const [site, time] of Object.entries(op.clock)) {
      if (time > (lastExportClock[site] || 0)) return true;
    }
    return false;
  });

  return {
    version: '1.0.0',
    format: 'incremental',
    exportedAt: new Date().toISOString(),
    baseClock: lastExportClock || {},
    currentClock: doc.vectorClock.getTimestamp(),
    ops: newOps,
    deltaNodes: state.nodes.filter(n => {
      const addOp = newOps.find(op => op.type === 'add_node' && op.nodeId === n.id);
      const updateOp = newOps.find(op => op.type === 'update_node' && op.nodeId === n.id);
      return addOp || updateOp;
    }),
    deltaEdges: state.edges.filter(e => {
      const addOp = newOps.find(op => op.type === 'add_edge' && op.edgeId === e.id);
      const updateOp = newOps.find(op => op.type === 'update_edge' && op.edgeId === e.id);
      return addOp || updateOp;
    }),
    removedNodeIds: newOps.filter(op => op.type === 'remove_node').map(op => op.nodeId),
    removedEdgeIds: newOps.filter(op => op.type === 'remove_edge').map(op => op.edgeId)
  };
}

export function exportStream(doc, chunkSize = 50) {
  const state = doc.getState();
  const lines = [];

  lines.push(JSON.stringify({
    version: '1.0.0',
    format: 'stream',
    type: 'stream_header',
    totalNodes: state.nodes.length,
    totalEdges: state.edges.length,
    clock: doc.vectorClock.getTimestamp(),
    exportedAt: new Date().toISOString()
  }));

  for (let i = 0; i < state.nodes.length; i += chunkSize) {
    lines.push(JSON.stringify({
      type: 'nodes_chunk',
      offset: i,
      total: state.nodes.length,
      data: state.nodes.slice(i, i + chunkSize)
    }));
  }

  for (let i = 0; i < state.edges.length; i += chunkSize) {
    lines.push(JSON.stringify({
      type: 'edges_chunk',
      offset: i,
      total: state.edges.length,
      data: state.edges.slice(i, i + chunkSize)
    }));
  }

  lines.push(JSON.stringify({
    type: 'stream_end',
    checksum: state.nodes.length + state.edges.length
  }));

  return lines.join('\n');
}

export function importFromJSON(data, doc) {
  const format = data.format || 'full';

  if (format === 'incremental') {
    return importIncremental(data, doc);
  }
  if (format === 'stream') {
    return importStreamData(data, doc);
  }

  const schema = data.schema || data;
  const currentState = doc.getState();
  const conflicts = detectImportConflicts(currentState, schema);

  if (conflicts.length > 0) {
    return { success: false, conflicts, data, schema };
  }

  applyImport(doc, schema);
  return { success: true, imported: { nodes: (schema.nodes || []).length, edges: (schema.edges || []).length } };
}

export function importIncremental(data, doc) {
  const currentClock = doc.vectorClock.getTimestamp();

  if (data.removedNodeIds) {
    for (const nodeId of data.removedNodeIds) {
      if (doc.nodes.has(nodeId)) {
        doc.removeNode(nodeId);
      }
    }
  }
  if (data.removedEdgeIds) {
    for (const edgeId of data.removedEdgeIds) {
      if (doc.edges.has(edgeId)) {
        doc.removeEdge(edgeId);
      }
    }
  }

  const currentState = doc.getState();
  const conflicts = [];

  for (const node of data.deltaNodes || []) {
    const existing = currentState.nodes.find(n => n.id === node.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(node)) {
      const diffs = diffNodeFields(existing, node);
      if (diffs.length > 0) {
        conflicts.push({
          nodeId: node.id,
          nodeName: node.name || existing.name,
          changes: diffs,
          current: existing,
          imported: node,
          resolution: 'keep_current'
        });
        continue;
      }
    }
    if (existing) {
      doc.updateNode(node.id, node);
    } else {
      doc.addNode(node);
    }
  }

  for (const edge of data.deltaEdges || []) {
    if (doc.edges.has(edge.id)) {
      doc.updateEdge(edge.id, edge);
    } else {
      doc.addEdge(edge);
    }
  }

  if (data.currentClock) {
    doc.vectorClock.merge(data.currentClock);
  }

  if (conflicts.length > 0) {
    return { success: false, conflicts, data, schema: { nodes: data.deltaNodes, edges: data.deltaEdges } };
  }

  return { success: true, imported: { nodes: (data.deltaNodes || []).length, edges: (data.deltaEdges || []).length } };
}

export function importStreamText(text, doc) {
  const lines = text.split('\n').filter(l => l.trim());
  let header = null;
  const nodes = [];
  const edges = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      switch (obj.type) {
        case 'stream_header':
          header = obj;
          break;
        case 'nodes_chunk':
          nodes.push(...obj.data);
          break;
        case 'edges_chunk':
          edges.push(...obj.data);
          break;
        case 'stream_end':
          break;
      }
    } catch (e) {
      continue;
    }
  }

  return importFromJSON({ format: 'full', schema: { nodes, edges } }, doc);
}

function importStreamData(data, doc) {
  return importFromJSON({ format: 'full', schema: data.schema || data }, doc);
}

export function detectImportConflicts(currentState, importedSchema) {
  const conflicts = [];
  const currentNodes = new Map((currentState.nodes || []).map(n => [n.id, n]));
  const importNodes = importedSchema.nodes || [];

  for (const importNode of importNodes) {
    const existing = currentNodes.get(importNode.id);
    if (!existing) continue;

    const fieldConflicts = diffNodeFields(existing, importNode);

    if (fieldConflicts.length > 0) {
      conflicts.push({
        nodeId: importNode.id,
        nodeName: importNode.name || existing.name,
        changes: fieldConflicts,
        current: existing,
        imported: importNode,
        resolution: 'keep_current'
      });
    }
  }

  return conflicts;
}

function diffNodeFields(existing, importNode) {
  const fieldConflicts = [];

  if (existing.name !== importNode.name) {
    fieldConflicts.push({
      type: 'rename',
      field: 'name',
      current: existing.name,
      imported: importNode.name
    });
  }

  const existingFields = new Map((existing.fields || []).map(f => [f.id || f.name, f]));
  const importedFields = new Map((importNode.fields || []).map(f => [f.id || f.name, f]));

  for (const [id, field] of importedFields) {
    const ef = existingFields.get(id);
    if (!ef) {
      fieldConflicts.push({ type: 'added', field: id, imported: field });
    } else if (JSON.stringify(ef) !== JSON.stringify(field)) {
      fieldConflicts.push({ type: 'modified', field: id, current: ef, imported: field });
    }
  }

  for (const [id, field] of existingFields) {
    if (!importedFields.has(id)) {
      fieldConflicts.push({ type: 'removed', field: id, current: field });
    }
  }

  return fieldConflicts;
}

export function applyImport(doc, schema, resolutions = null) {
  const currentState = doc.getState();
  const currentNodeIds = new Set(currentState.nodes.map(n => n.id));
  const currentEdgeIds = new Set(currentState.edges.map(e => e.id));
  const resolvedNodes = new Map();

  if (resolutions) {
    for (const res of resolutions) {
      resolvedNodes.set(res.nodeId, res.resolution);
    }
  }

  for (const node of schema.nodes || []) {
    if (currentNodeIds.has(node.id)) {
      const resolution = resolvedNodes.get(node.id) || 'keep_current';
      if (resolution === 'use_imported') {
        doc.updateNode(node.id, JSON.parse(JSON.stringify(node)));
      } else if (resolution === 'merge') {
        const existing = currentState.nodes.find(n => n.id === node.id);
        const merged = mergeNodes(existing, node);
        doc.updateNode(node.id, merged);
      }
    } else {
      doc.addNode(JSON.parse(JSON.stringify(node)));
    }
  }

  for (const edge of schema.edges || []) {
    if (currentEdgeIds.has(edge.id)) {
      const resolution = resolvedNodes.get(edge.id);
      if (resolution === 'use_imported') {
        doc.updateEdge(edge.id, JSON.parse(JSON.stringify(edge)));
      }
    } else {
      doc.addEdge(JSON.parse(JSON.stringify(edge)));
    }
  }
}

function mergeNodes(current, imported) {
  const merged = { ...current };
  const existingFields = new Map((current.fields || []).map(f => [f.id || f.name, f]));
  const importedFields = (imported.fields || []);

  const mergedFields = [...(current.fields || [])];
  for (const field of importedFields) {
    const key = field.id || field.name;
    if (!existingFields.has(key)) {
      mergedFields.push(field);
    } else {
      const idx = mergedFields.findIndex(f => (f.id || f.name) === key);
      if (idx >= 0) {
        mergedFields[idx] = { ...mergedFields[idx], ...field };
      }
    }
  }

  merged.fields = mergedFields;
  if (imported.name && imported.name !== current.name) {
    merged.name = imported.name;
  }
  return merged;
}

export function saveToLocalStorage(key, doc, versionControl) {
  const data = exportToJSON(doc, versionControl);
  const json = JSON.stringify(data);

  try {
    const chunks = [];
    const chunkSize = 1024 * 512;
    for (let i = 0; i < json.length; i += chunkSize) {
      chunks.push(json.slice(i, i + chunkSize));
    }
    localStorage.setItem(`${key}_meta`, JSON.stringify({ chunks: chunks.length, savedAt: Date.now() }));
    for (let i = 0; i < chunks.length; i++) {
      localStorage.setItem(`${key}_${i}`, chunks[i]);
    }
    return true;
  } catch (e) {
    console.error('LocalStorage save failed:', e);
    return false;
  }
}

export function loadFromLocalStorage(key) {
  try {
    const meta = localStorage.getItem(`${key}_meta`);
    if (!meta) return null;

    const { chunks } = JSON.parse(meta);
    let json = '';
    for (let i = 0; i < chunks; i++) {
      const chunk = localStorage.getItem(`${key}_${i}`);
      if (!chunk) return null;
      json += chunk;
    }

    return JSON.parse(json);
  } catch (e) {
    console.error('LocalStorage load failed:', e);
    return null;
  }
}
