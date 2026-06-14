export function exportToJSON(doc, versionControl) {
  const state = doc.getState();
  const branches = versionControl.getBranches();
  const commits = versionControl.commits;

  return {
    version: '1.0.0',
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
  const ops = doc.opLog.filter(op => {
    if (!lastExportClock) return true;
    for (const [site, time] of Object.entries(op.clock)) {
      if (time > (lastExportClock[site] || 0)) return true;
    }
    return false;
  });

  return {
    version: '1.0.0',
    type: 'incremental',
    exportedAt: new Date().toISOString(),
    baseClock: lastExportClock || {},
    ops,
    currentClock: doc.vectorClock.getTimestamp()
  };
}

export function* streamExport(doc, chunkSize = 50) {
  const state = doc.getState();

  yield JSON.stringify({
    version: '1.0.0',
    type: 'stream_start',
    totalNodes: state.nodes.length,
    totalEdges: state.edges.length,
    exportedAt: new Date().toISOString()
  }) + '\n';

  for (let i = 0; i < state.nodes.length; i += chunkSize) {
    yield JSON.stringify({
      type: 'nodes_chunk',
      offset: i,
      data: state.nodes.slice(i, i + chunkSize)
    }) + '\n';
  }

  for (let i = 0; i < state.edges.length; i += chunkSize) {
    yield JSON.stringify({
      type: 'edges_chunk',
      offset: i,
      data: state.edges.slice(i, i + chunkSize)
    }) + '\n';
  }

  yield JSON.stringify({
    type: 'stream_end',
    clock: doc.vectorClock.getTimestamp()
  }) + '\n';
}

export function importFromJSON(data, doc) {
  const currentState = doc.getState();
  const conflicts = detectImportConflicts(currentState, data.schema || data);

  if (conflicts.length > 0) {
    return { success: false, conflicts, data };
  }

  applyImport(doc, data.schema || data);
  return { success: true };
}

export function importStream(lines, doc) {
  let metadata = null;
  const chunks = { nodes: [], edges: [] };

  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);

    switch (obj.type) {
      case 'stream_start':
        metadata = obj;
        break;
      case 'nodes_chunk':
        chunks.nodes.push(...obj.data);
        break;
      case 'edges_chunk':
        chunks.edges.push(...obj.data);
        break;
      case 'stream_end':
        break;
    }
  }

  return importFromJSON({ schema: { nodes: chunks.nodes, edges: chunks.edges } }, doc);
}

export function detectImportConflicts(currentState, importedSchema) {
  const conflicts = [];
  const currentNodes = new Map((currentState.nodes || []).map(n => [n.id, n]));
  const importNodes = importedSchema.nodes || [];
  const importEdges = importedSchema.edges || [];

  for (const importNode of importNodes) {
    const existing = currentNodes.get(importNode.id);
    if (!existing) continue;

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
        doc.updateNode(node.id, node);
      } else if (resolution === 'merge') {
        const existing = currentState.nodes.find(n => n.id === node.id);
        const merged = mergeNodes(existing, node);
        doc.updateNode(node.id, merged);
      }
    } else {
      doc.addNode(node);
    }
  }

  for (const edge of schema.edges || []) {
    if (!currentEdgeIds.has(edge.id)) {
      doc.addEdge(edge);
    }
  }
}

function mergeNodes(current, imported) {
  const merged = { ...current };
  const existingFields = new Map((current.fields || []).map(f => [f.id || f.name, f]));
  const importedFields = (imported.fields || []);

  for (const field of importedFields) {
    const key = field.id || field.name;
    if (!existingFields.has(key)) {
      if (!merged.fields) merged.fields = [];
      merged.fields.push(field);
    }
  }

  return merged;
}

export function saveToLocalStorage(key, doc, versionControl) {
  const data = exportToJSON(doc, versionControl);
  const json = JSON.stringify(data);

  const chunks = [];
  const chunkSize = 1024 * 512;
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.slice(i, i + chunkSize));
  }

  localStorage.setItem(`${key}_meta`, JSON.stringify({ chunks: chunks.length, savedAt: Date.now() }));
  for (let i = 0; i < chunks.length; i++) {
    localStorage.setItem(`${key}_${i}`, chunks[i]);
  }
}

export function loadFromLocalStorage(key) {
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
}
