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
    this.branchPoints = new Map();

    this.branches.set('main', {
      name: 'main',
      head: null,
      created: Date.now()
    });
  }

  commit(message) {
    const state = this.doc.getState();
    const commitObj = {
      id: 'commit_' + Math.random().toString(36).substr(2, 9),
      branch: this.currentBranch,
      message,
      state: JSON.parse(JSON.stringify(state)),
      timestamp: Date.now(),
      parent: this.branches.get(this.currentBranch).head
    };
    this.commits.push(commitObj);
    this.branches.get(this.currentBranch).head = commitObj.id;
    return commitObj;
  }

  createBranch(name) {
    if (this.branches.has(name)) return null;
    const state = this.doc.getState();
    const branch = {
      name,
      head: this.branches.get(this.currentBranch).head,
      created: Date.now(),
      parentBranch: this.currentBranch
    };
    this.branches.set(name, branch);
    this.branchPoints.set(name, JSON.parse(JSON.stringify(state)));
    return branch;
  }

  switchBranch(name) {
    if (!this.branches.has(name)) return false;
    const head = this.branches.get(name).head;
    if (head) {
      const commit = this.commits.find(c => c.id === head);
      if (commit) {
        this.doc.nodes = new (this.doc.nodes.constructor)(this.doc.siteId);
        this.doc.edges = new (this.doc.edges.constructor)(this.doc.siteId);
        this.doc.loadState(commit.state);
      }
    } else if (this.branchPoints.has(name)) {
      const state = this.branchPoints.get(name);
      this.doc.nodes = new (this.doc.nodes.constructor)(this.doc.siteId);
      this.doc.edges = new (this.doc.edges.constructor)(this.doc.siteId);
      this.doc.loadState(state);
    }
    this.currentBranch = name;
    return true;
  }

  mergeBranch(sourceBranch) {
    if (!this.branches.has(sourceBranch)) return { success: false, error: 'Branch not found' };

    const sourceHead = this.branches.get(sourceBranch).head;
    if (!sourceHead) return { success: false, error: 'Source branch has no commits' };

    const sourceCommit = this.commits.find(c => c.id === sourceHead);
    if (!sourceCommit) return { success: false, error: 'Source commit not found' };

    const currentState = this.doc.getState();
    const sourceState = sourceCommit.state;
    const conflicts = this.detectConflicts(currentState, sourceState);

    if (conflicts.length > 0) {
      return { success: false, conflicts, sourceState };
    }

    this.applyMerge(currentState, sourceState);
    this.commit(`Merge ${sourceBranch} into ${this.currentBranch}`);
    return { success: true };
  }

  detectConflicts(current, source) {
    const conflicts = [];
    const currentNodes = new Map(current.nodes.map(n => [n.id, n]));
    const sourceNodes = new Map(source.nodes.map(n => [n.id, n]));

    for (const [id, sourceNode] of sourceNodes) {
      const currentNode = currentNodes.get(id);
      if (currentNode) {
        if (JSON.stringify(currentNode) !== JSON.stringify(sourceNode)) {
          conflicts.push({
            type: 'node_conflict',
            nodeId: id,
            current: currentNode,
            source: sourceNode
          });
        }
      }
    }
    return conflicts;
  }

  applyMerge(current, source) {
    const currentNodeIds = new Set(current.nodes.map(n => n.id));
    const currentEdgeIds = new Set(current.edges.map(e => e.id));

    for (const node of source.nodes) {
      if (!currentNodeIds.has(node.id)) {
        this.doc.addNode(node);
      }
    }
    for (const edge of source.edges) {
      if (!currentEdgeIds.has(edge.id)) {
        this.doc.addEdge(edge);
      }
    }
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
    this.branchPoints.delete(name);
    return true;
  }
}
