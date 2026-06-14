import { LWWMap } from './crdt.js';

export class HistoryManager {
  constructor(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 10000;
    this.batchMode = false;
    this.currentBatch = null;
  }

  beginBatch(description) {
    this.batchMode = true;
    this.currentBatch = { description, ops: [], timestamp: Date.now() };
  }

  endBatch() {
    if (this.currentBatch && this.currentBatch.ops.length > 0) {
      this.undoStack.push(this.currentBatch);
      if (this.undoStack.length > this.maxHistory) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.batchMode = false;
    this.currentBatch = null;
  }

  record(action) {
    const entry = {
      description: action.description,
      forward: action.forward,
      backward: action.backward,
      timestamp: Date.now()
    };

    if (this.batchMode && this.currentBatch) {
      this.currentBatch.ops.push(entry);
    } else {
      this.undoStack.push({ description: action.description, ops: [entry], timestamp: Date.now() });
      if (this.undoStack.length > this.maxHistory) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }
  }

  undo() {
    if (this.undoStack.length === 0) return null;
    const batch = this.undoStack.pop();
    for (let i = batch.ops.length - 1; i >= 0; i--) {
      batch.ops[i].backward();
    }
    this.redoStack.push(batch);
    return batch;
  }

  redo() {
    if (this.redoStack.length === 0) return null;
    const batch = this.redoStack.pop();
    for (const op of batch.ops) {
      op.forward();
    }
    this.undoStack.push(batch);
    return batch;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  getHistory() {
    return this.undoStack.map((batch, idx) => ({
      index: idx,
      description: batch.description,
      timestamp: batch.timestamp,
      opCount: batch.ops.length
    }));
  }

  goToState(index) {
    while (this.undoStack.length > index + 1) {
      this.undo();
    }
    while (this.undoStack.length < index + 1 && this.redoStack.length > 0) {
      this.redo();
    }
  }
}

export class VersionControl {
  constructor(doc) {
    this.doc = doc;
    this.branches = new Map();
    this.currentBranch = 'main';
    this.commits = [];

    this.branches.set('main', {
      name: 'main',
      head: null,
      created: Date.now(),
      parentBranch: null
    });
  }

  snapshot() {
    const state = this.doc.getState();
    return JSON.parse(JSON.stringify(state));
  }

  restoreSnapshot(snap) {
    this.doc.nodes = new LWWMap(this.doc.siteId);
    this.doc.edges = new LWWMap(this.doc.siteId);
    for (const node of snap.nodes || []) {
      this.doc.nodes.set(node.id, JSON.parse(JSON.stringify(node)));
    }
    for (const edge of snap.edges || []) {
      this.doc.edges.set(edge.id, JSON.parse(JSON.stringify(edge)));
    }
    if (snap.clock) this.doc.vectorClock.merge(snap.clock);
    this.doc.notify({ type: 'state_sync', source: 'branch_switch' });
  }

  commit(message) {
    const snap = this.snapshot();
    const branch = this.branches.get(this.currentBranch);
    const commitObj = {
      id: 'commit_' + Math.random().toString(36).substr(2, 9),
      branch: this.currentBranch,
      message,
      state: snap,
      timestamp: Date.now(),
      parent: branch.head
    };
    this.commits.push(commitObj);
    branch.head = commitObj.id;
    return commitObj;
  }

  createBranch(name) {
    if (this.branches.has(name)) return null;

    this.commit(`自动快照: 创建分支 ${name} 前`);

    const branch = {
      name,
      head: this.branches.get(this.currentBranch).head,
      created: Date.now(),
      parentBranch: this.currentBranch,
      forkPoint: this.branches.get(this.currentBranch).head
    };
    this.branches.set(name, branch);
    return branch;
  }

  switchBranch(name) {
    if (!this.branches.has(name)) return false;
    if (name === this.currentBranch) return true;

    this.commit(`自动快照: 切换分支前 (${this.currentBranch})`);

    const targetBranch = this.branches.get(name);
    if (targetBranch.head) {
      const commit = this.commits.find(c => c.id === targetBranch.head);
      if (commit && commit.state) {
        this.restoreSnapshot(commit.state);
      }
    }

    this.currentBranch = name;
    return true;
  }

  mergeBranch(sourceBranchName) {
    if (!this.branches.has(sourceBranchName)) {
      return { success: false, error: `分支 "${sourceBranchName}" 不存在` };
    }

    const sourceBranch = this.branches.get(sourceBranchName);
    if (!sourceBranch.head) {
      return { success: false, error: `分支 "${sourceBranchName}" 没有提交记录` };
    }

    const sourceCommit = this.commits.find(c => c.id === sourceBranch.head);
    if (!sourceCommit || !sourceCommit.state) {
      return { success: false, error: '无法找到源分支的提交状态' };
    }

    const currentState = this.snapshot();
    const sourceState = sourceCommit.state;

    const baseCommitId = sourceBranch.forkPoint || null;
    const baseState = baseCommitId
      ? (this.commits.find(c => c.id === baseCommitId)?.state || { nodes: [], edges: [] })
      : { nodes: [], edges: [] };

    const conflicts = this.detectThreeWayConflicts(baseState, currentState, sourceState);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
        sourceState,
        baseState,
        currentState
      };
    }

    this.applyThreeWayMerge(baseState, currentState, sourceState);
    this.commit(`合并分支 "${sourceBranchName}" 到 "${this.currentBranch}"`);
    return { success: true, mergedNodes: sourceState.nodes.length };
  }

  detectThreeWayConflicts(base, current, source) {
    const conflicts = [];
    const baseNodes = new Map((base.nodes || []).map(n => [n.id, n]));
    const currentNodes = new Map((current.nodes || []).map(n => [n.id, n]));
    const sourceNodes = new Map((source.nodes || []).map(n => [n.id, n]));

    for (const [id, sourceNode] of sourceNodes) {
      const currentNode = currentNodes.get(id);
      const baseNode = baseNodes.get(id);

      if (!currentNode) continue;

      const currentChanged = baseNode ? JSON.stringify(currentNode) !== JSON.stringify(baseNode) : false;
      const sourceChanged = baseNode ? JSON.stringify(sourceNode) !== JSON.stringify(baseNode) : false;

      if (currentChanged && sourceChanged && JSON.stringify(currentNode) !== JSON.stringify(sourceNode)) {
        const fieldDiffs = this.diffFields(currentNode, sourceNode, baseNode);
        if (fieldDiffs.length > 0) {
          conflicts.push({
            type: 'node_conflict',
            nodeId: id,
            nodeName: currentNode.name || sourceNode.name,
            current: currentNode,
            source: sourceNode,
            base: baseNode,
            changes: fieldDiffs,
            resolution: 'keep_current'
          });
        }
      }
    }

    return conflicts;
  }

  diffFields(current, source, base) {
    const diffs = [];
    const currentFields = new Map((current.fields || []).map(f => [f.id || f.name, f]));
    const sourceFields = new Map((source.fields || []).map(f => [f.id || f.name, f]));
    const baseFields = new Map((base?.fields || []).map(f => [f.id || f.name, f]));

    if (current.name !== source.name && (!base || current.name !== base.name) && (!base || source.name !== base.name)) {
      diffs.push({ type: 'rename', field: 'name', current: current.name, imported: source.name });
    }

    for (const [key, sf] of sourceFields) {
      const cf = currentFields.get(key);
      const bf = baseFields.get(key);
      if (!cf && !bf) {
        continue;
      }
      if (cf && JSON.stringify(cf) !== JSON.stringify(sf)) {
        const cfChanged = bf ? JSON.stringify(cf) !== JSON.stringify(bf) : true;
        const sfChanged = bf ? JSON.stringify(sf) !== JSON.stringify(bf) : true;
        if (cfChanged && sfChanged) {
          diffs.push({ type: 'modified', field: key, current: cf, imported: sf });
        }
      }
    }

    for (const [key, cf] of currentFields) {
      if (!sourceFields.has(key) && baseFields.has(key)) {
        diffs.push({ type: 'removed', field: key, current: cf });
      }
    }

    return diffs;
  }

  applyThreeWayMerge(base, current, source) {
    const currentNodeIds = new Set((current.nodes || []).map(n => n.id));
    const currentEdgeIds = new Set((current.edges || []).map(e => e.id));
    const baseNodeIds = new Set((base.nodes || []).map(n => n.id));
    const baseEdgeIds = new Set((base.edges || []).map(e => e.id));

    for (const node of source.nodes || []) {
      if (!currentNodeIds.has(node.id)) {
        if (!baseNodeIds.has(node.id)) {
          this.doc.addNode(JSON.parse(JSON.stringify(node)));
        }
      }
    }

    for (const edge of source.edges || []) {
      if (!currentEdgeIds.has(edge.id)) {
        if (!baseEdgeIds.has(edge.id)) {
          this.doc.addEdge(JSON.parse(JSON.stringify(edge)));
        }
      }
    }

    const sourceNodeIds = new Set((source.nodes || []).map(n => n.id));
    for (const nodeId of currentNodeIds) {
      if (baseNodeIds.has(nodeId) && !sourceNodeIds.has(nodeId)) {
        this.doc.removeNode(nodeId);
      }
    }
  }

  applyResolutions(conflicts, sourceState) {
    for (const conflict of conflicts) {
      switch (conflict.resolution) {
        case 'use_imported':
          this.doc.updateNode(conflict.nodeId, JSON.parse(JSON.stringify(conflict.source)));
          break;
        case 'merge': {
          const merged = this.mergeNodeData(conflict.current, conflict.source);
          this.doc.updateNode(conflict.nodeId, merged);
          break;
        }
        case 'keep_current':
        default:
          break;
      }
    }

    const currentNodeIds = new Set(this.doc.getState().nodes.map(n => n.id));
    const currentEdgeIds = new Set(this.doc.getState().edges.map(e => e.id));

    for (const node of sourceState.nodes || []) {
      if (!currentNodeIds.has(node.id)) {
        this.doc.addNode(JSON.parse(JSON.stringify(node)));
      }
    }
    for (const edge of sourceState.edges || []) {
      if (!currentEdgeIds.has(edge.id)) {
        this.doc.addEdge(JSON.parse(JSON.stringify(edge)));
      }
    }

    this.commit(`合并完成 (含冲突裁决)`);
  }

  mergeNodeData(current, source) {
    const merged = { ...current };
    const currentFields = new Map((current.fields || []).map(f => [f.id || f.name, f]));
    const sourceFields = (source.fields || []);
    const mergedFields = [...(current.fields || [])];

    for (const sf of sourceFields) {
      const key = sf.id || sf.name;
      if (!currentFields.has(key)) {
        mergedFields.push(sf);
      }
    }

    merged.fields = mergedFields;
    return merged;
  }

  getBranches() {
    return Array.from(this.branches.values());
  }

  getCommits(branch) {
    return this.commits.filter(c => c.branch === (branch || this.currentBranch));
  }

  deleteBranch(name) {
    if (name === 'main' || name === this.currentBranch) return false;
    this.branches.delete(name);
    return true;
  }
}
