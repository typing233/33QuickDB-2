import { CRDTDocument } from './crdt.js';
import { HistoryManager, VersionControl } from './history.js';
import { OrthogonalRouter, CardinalityChecker } from './routing.js';
import { CanvasRenderer } from './canvas.js';
import { Collaboration } from './collaboration.js';
import {
  exportToJSON, exportIncremental, importFromJSON,
  detectImportConflicts, applyImport,
  saveToLocalStorage, loadFromLocalStorage
} from './io.js';

class QuickDBApp {
  constructor() {
    this.doc = new CRDTDocument();
    this.history = new HistoryManager(this.doc);
    this.versionControl = new VersionControl(this.doc);
    this.router = new OrthogonalRouter();
    this.cardinalityChecker = new CardinalityChecker();
    this.collaboration = new Collaboration(this.doc);

    this.canvas = document.getElementById('main-canvas');
    this.renderer = new CanvasRenderer(this.canvas, this);

    this.selectedNodes = new Set();
    this.selectedEdge = null;
    this.dragState = null;
    this.selectionBox = null;
    this.editingNode = null;
    this.clipboard = [];
    this.lastExportClock = null;

    this.initEventListeners();
    this.initToolbar();
    this.initSidebar();
    this.initModals();
    this.initCollaboration();
    this.loadSavedState();

    this.renderer.startRenderLoop();
    this.doc.subscribe(() => {
      this.renderer.requestRender();
      this.checkConstraints();
    });
  }

  generateId() {
    return 'id_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  initEventListeners() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('paste', (e) => this.onPaste(e));
    document.addEventListener('copy', (e) => this.onCopy(e));

    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    canvas.addEventListener('drop', (e) => this.onDrop(e));
  }

  onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.renderer.viewport.screenToWorld(sx, sy);

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.dragState = { type: 'pan', startX: sx, startY: sy };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0) {
      const state = this.doc.getState();
      const hitNode = this.renderer.hitTestNode(world.x, world.y, state.nodes);

      if (hitNode) {
        const fkHit = this.renderer.hitTestFieldFK(world.x, world.y, hitNode);
        if (fkHit) {
          const nodeW = hitNode.width || 220;
          this.dragState = {
            type: 'create_edge',
            sourceId: hitNode.id,
            fieldIndex: fkHit.fieldIndex,
            startX: hitNode.x + nodeW,
            startY: hitNode.y + 32 + fkHit.fieldIndex * 24 + 12,
            currentX: world.x,
            currentY: world.y
          };
          this.canvas.style.cursor = 'crosshair';
          return;
        }

        if (!this.selectedNodes.has(hitNode.id)) {
          if (!e.shiftKey) this.selectedNodes.clear();
          this.selectedNodes.add(hitNode.id);
        }
        this.selectedEdge = null;

        this.dragState = {
          type: 'move_nodes',
          startX: world.x,
          startY: world.y,
          nodeStarts: new Map()
        };
        for (const id of this.selectedNodes) {
          const n = state.nodes.find(nd => nd.id === id);
          if (n) this.dragState.nodeStarts.set(id, { x: n.x, y: n.y });
        }

        this.showProperties(hitNode);
        this.renderer.requestRender();
        return;
      }

      const hitEdge = this.renderer.hitTestEdge(world.x, world.y, state.edges, state.nodes);
      if (hitEdge) {
        this.selectedNodes.clear();
        this.selectedEdge = hitEdge.id;
        this.showEdgeProperties(hitEdge);
        this.renderer.requestRender();
        return;
      }

      this.selectedNodes.clear();
      this.selectedEdge = null;
      this.hideProperties();
      this.selectionBox = { startX: sx, startY: sy, endX: sx, endY: sy };
      this.renderer.requestRender();
    }
  }

  onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.renderer.viewport.screenToWorld(sx, sy);

    this.collaboration.broadcastCursor(world);

    if (!this.dragState && !this.selectionBox) return;

    if (this.dragState?.type === 'pan') {
      const dx = sx - this.dragState.startX;
      const dy = sy - this.dragState.startY;
      this.renderer.viewport.pan(dx, dy);
      this.dragState.startX = sx;
      this.dragState.startY = sy;
      this.renderer.requestRender();
      return;
    }

    if (this.dragState?.type === 'move_nodes') {
      const dx = world.x - this.dragState.startX;
      const dy = world.y - this.dragState.startY;

      for (const [id, start] of this.dragState.nodeStarts) {
        const node = this.doc.nodes.get(id);
        if (node) {
          node.x = start.x + dx;
          node.y = start.y + dy;
          this.doc.nodes.set(id, node);
        }
      }
      this.renderer.requestRender();
      return;
    }

    if (this.dragState?.type === 'create_edge') {
      this.dragState.currentX = world.x;
      this.dragState.currentY = world.y;
      this.renderer.requestRender();
      return;
    }

    if (this.selectionBox) {
      this.selectionBox.endX = sx;
      this.selectionBox.endY = sy;
      this.renderer.requestRender();
    }
  }

  onMouseUp(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.renderer.viewport.screenToWorld(sx, sy);

    if (this.dragState?.type === 'pan') {
      this.canvas.style.cursor = 'default';
    }

    if (this.dragState?.type === 'move_nodes') {
      const dx = world.x - this.dragState.startX;
      const dy = world.y - this.dragState.startY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        const moves = [];
        for (const [id, start] of this.dragState.nodeStarts) {
          moves.push({ id, from: start, to: { x: start.x + dx, y: start.y + dy } });
        }

        this.history.record({
          description: `移动 ${moves.length} 个节点`,
          forward: () => {
            for (const m of moves) {
              this.doc.updateNode(m.id, { x: m.to.x, y: m.to.y });
            }
          },
          backward: () => {
            for (const m of moves) {
              this.doc.updateNode(m.id, { x: m.from.x, y: m.from.y });
            }
          }
        });

        for (const m of moves) {
          this.doc.updateNode(m.id, { x: m.to.x, y: m.to.y });
        }
        this.broadcastChanges();
      }
    }

    if (this.dragState?.type === 'create_edge') {
      this.canvas.style.cursor = 'default';
      const state = this.doc.getState();
      const targetNode = this.renderer.hitTestNode(world.x, world.y, state.nodes);

      if (targetNode && targetNode.id !== this.dragState.sourceId) {
        this.createEdge(this.dragState.sourceId, targetNode.id, this.dragState.fieldIndex);
      }
    }

    if (this.selectionBox) {
      const vp = this.renderer.viewport;
      const x1 = Math.min(this.selectionBox.startX, this.selectionBox.endX);
      const y1 = Math.min(this.selectionBox.startY, this.selectionBox.endY);
      const x2 = Math.max(this.selectionBox.startX, this.selectionBox.endX);
      const y2 = Math.max(this.selectionBox.startY, this.selectionBox.endY);

      const w1 = vp.screenToWorld(x1, y1);
      const w2 = vp.screenToWorld(x2, y2);

      const state = this.doc.getState();
      for (const node of state.nodes) {
        const nw = node.width || 220;
        const nh = node.height || 60;
        if (node.x + nw >= w1.x && node.x <= w2.x &&
            node.y + nh >= w1.y && node.y <= w2.y) {
          this.selectedNodes.add(node.id);
        }
      }
      this.selectionBox = null;
      this.renderer.requestRender();
    }

    this.dragState = null;
    this.updateToolbarState();
  }

  onDoubleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.renderer.viewport.screenToWorld(sx, sy);

    const state = this.doc.getState();
    const hitNode = this.renderer.hitTestNode(world.x, world.y, state.nodes);

    if (hitNode) {
      this.openNodeEditor(hitNode, sx, sy);
    }
  }

  onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const delta = -e.deltaY * 0.001;
    const newZoom = this.renderer.viewport.zoom * (1 + delta);
    this.renderer.viewport.zoomTo(newZoom, cx, cy);
    this.renderer.requestRender();
    this.updateZoomDisplay();
  }

  onKeyDown(e) {
    if (this.editingNode) return;

    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case 'z':
          e.preventDefault();
          if (e.shiftKey) this.redo();
          else this.undo();
          break;
        case 'y':
          e.preventDefault();
          this.redo();
          break;
        case 's':
          e.preventDefault();
          this.save();
          break;
        case 'a':
          e.preventDefault();
          this.selectAll();
          break;
        case 'c':
          this.copySelected();
          break;
        case 'v':
          this.pasteClipboard();
          break;
      }
      return;
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        break;
      case 'Escape':
        this.selectedNodes.clear();
        this.selectedEdge = null;
        this.closeNodeEditor();
        this.renderer.requestRender();
        break;
    }
  }

  onDrop(e) {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (type !== 'table') return;

    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.renderer.viewport.screenToWorld(sx, sy);

    this.createNode(world.x - 110, world.y - 30);
  }

  onCopy(e) {
    if (this.editingNode) return;
    if (this.selectedNodes.size === 0) return;
    e.preventDefault();
    this.copySelected();
  }

  onPaste(e) {
    if (this.editingNode) return;
    if (this.clipboard.length === 0) return;
    e.preventDefault();
    this.pasteClipboard();
  }

  createNode(x, y, name) {
    const node = {
      id: this.generateId(),
      name: name || `table_${Date.now().toString(36).slice(-4)}`,
      x, y,
      width: 220,
      height: 80,
      fields: [
        { id: this.generateId(), name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false, fkRef: null }
      ]
    };

    this.history.record({
      description: `创建表 ${node.name}`,
      forward: () => this.doc.addNode(node),
      backward: () => this.doc.removeNode(node.id)
    });

    this.doc.addNode(node);
    this.broadcastChanges();
    this.renderer.requestRender();
    return node;
  }

  createEdge(sourceId, targetId, fieldIndex) {
    const sourceNode = this.doc.nodes.get(sourceId);
    if (!sourceNode) return;

    const edge = {
      id: this.generateId(),
      sourceId,
      targetId,
      sourceCardinality: '1..1',
      targetCardinality: '0..n',
      fieldIndex
    };

    if (sourceNode.fields && sourceNode.fields[fieldIndex]) {
      sourceNode.fields[fieldIndex].fkRef = targetId;
      this.doc.updateNode(sourceId, sourceNode);
    }

    this.history.record({
      description: `创建关系 ${sourceId} → ${targetId}`,
      forward: () => this.doc.addEdge(edge),
      backward: () => this.doc.removeEdge(edge.id)
    });

    this.doc.addEdge(edge);
    this.broadcastChanges();
    this.renderer.requestRender();
    this.checkConstraints();
  }

  deleteSelected() {
    const state = this.doc.getState();

    if (this.selectedEdge) {
      const edge = state.edges.find(e => e.id === this.selectedEdge);
      if (edge) {
        this.history.record({
          description: '删除关系',
          forward: () => this.doc.removeEdge(edge.id),
          backward: () => this.doc.addEdge(edge)
        });
        this.doc.removeEdge(edge.id);
        this.selectedEdge = null;
      }
    }

    if (this.selectedNodes.size > 0) {
      const nodesToDelete = [];
      const edgesToDelete = [];

      for (const id of this.selectedNodes) {
        const node = state.nodes.find(n => n.id === id);
        if (node) nodesToDelete.push(node);
      }

      for (const edge of state.edges) {
        if (this.selectedNodes.has(edge.sourceId) || this.selectedNodes.has(edge.targetId)) {
          edgesToDelete.push(edge);
        }
      }

      this.history.record({
        description: `删除 ${nodesToDelete.length} 个节点`,
        forward: () => {
          for (const e of edgesToDelete) this.doc.removeEdge(e.id);
          for (const n of nodesToDelete) this.doc.removeNode(n.id);
        },
        backward: () => {
          for (const n of nodesToDelete) this.doc.addNode(n);
          for (const e of edgesToDelete) this.doc.addEdge(e);
        }
      });

      for (const e of edgesToDelete) this.doc.removeEdge(e.id);
      for (const n of nodesToDelete) this.doc.removeNode(n.id);
      this.selectedNodes.clear();
    }

    this.broadcastChanges();
    this.renderer.requestRender();
    this.hideProperties();
  }

  copySelected() {
    const state = this.doc.getState();
    this.clipboard = [];
    for (const id of this.selectedNodes) {
      const node = state.nodes.find(n => n.id === id);
      if (node) this.clipboard.push(JSON.parse(JSON.stringify(node)));
    }
  }

  pasteClipboard() {
    if (this.clipboard.length === 0) return;

    this.history.beginBatch(`粘贴 ${this.clipboard.length} 个节点`);

    const idMap = new Map();
    const newNodes = [];

    for (const original of this.clipboard) {
      const newId = this.generateId();
      idMap.set(original.id, newId);

      const node = {
        ...original,
        id: newId,
        x: original.x + 40,
        y: original.y + 40,
        fields: original.fields.map(f => ({
          ...f,
          id: this.generateId(),
          fkRef: f.fkRef ? (idMap.get(f.fkRef) || f.fkRef) : null
        }))
      };

      this.history.record({
        description: `粘贴表 ${node.name}`,
        forward: () => this.doc.addNode(node),
        backward: () => this.doc.removeNode(node.id)
      });
      this.doc.addNode(node);
      newNodes.push(node);
    }

    this.history.endBatch();
    this.selectedNodes.clear();
    for (const n of newNodes) this.selectedNodes.add(n.id);
    this.broadcastChanges();
    this.renderer.requestRender();
  }

  selectAll() {
    const state = this.doc.getState();
    this.selectedNodes.clear();
    for (const node of state.nodes) {
      this.selectedNodes.add(node.id);
    }
    this.renderer.requestRender();
  }

  undo() {
    const result = this.history.undo();
    if (result) {
      this.broadcastChanges();
      this.renderer.requestRender();
    }
    this.updateToolbarState();
  }

  redo() {
    const result = this.history.redo();
    if (result) {
      this.broadcastChanges();
      this.renderer.requestRender();
    }
    this.updateToolbarState();
  }

  save() {
    saveToLocalStorage('quickdb_state', this.doc, this.versionControl);
    this.showToast('已保存');
  }

  loadSavedState() {
    const data = loadFromLocalStorage('quickdb_state');
    if (data && data.schema) {
      this.doc.loadState(data.schema);
      this.renderer.requestRender();
    }
  }

  broadcastChanges() {
    const ops = this.doc.getPendingOps();
    this.collaboration.broadcastOps(ops);
  }

  checkConstraints() {
    const state = this.doc.getState();
    const warnings = this.cardinalityChecker.checkConsistency(state.edges, state.nodes);
    this.showWarnings(warnings);
  }

  // === UI: Node Editor ===

  openNodeEditor(node, screenX, screenY) {
    this.editingNode = node.id;
    const editor = document.getElementById('node-editor');
    editor.style.display = 'block';
    editor.style.left = screenX + 'px';
    editor.style.top = screenY + 'px';

    const nodeData = this.doc.nodes.get(node.id);
    this.renderNodeEditor(nodeData, editor);
  }

  renderNodeEditor(node, editor) {
    const fields = node.fields || [];
    const maxVisible = 15;
    const hasVirtualScroll = fields.length > maxVisible;
    const scrollOffset = this.renderer.virtualScrollState.get(node.id)?.offset || 0;
    const visibleFields = fields.slice(scrollOffset, scrollOffset + maxVisible);

    editor.innerHTML = `
      <div class="node-editor-header">
        <input type="text" value="${this.escapeHtml(node.name)}" id="edit-table-name" placeholder="表名">
      </div>
      <div class="field-list" id="field-list">
        ${visibleFields.map((f, i) => `
          <div class="field-row" data-index="${scrollOffset + i}">
            <input type="text" class="field-name" value="${this.escapeHtml(f.name)}" placeholder="字段名">
            <select class="field-type">
              ${this.getTypeOptions(f.type)}
            </select>
            <span class="field-badge badge-pk ${f.isPK ? '' : 'inactive'}" data-toggle="pk" title="主键">${f.isPK ? 'PK' : 'pk'}</span>
            <span class="field-badge badge-nn ${f.notNull ? '' : 'inactive'}" data-toggle="nn" title="非空">${f.notNull ? 'NN' : 'nn'}</span>
            <span class="field-badge badge-fk ${f.isFK ? '' : 'inactive'}" data-toggle="fk" title="外键">FK</span>
            <span class="field-delete" title="删除字段">×</span>
          </div>
        `).join('')}
        ${hasVirtualScroll ? `
          <div style="text-align:center;padding:4px;font-size:10px;color:#a0a0b0">
            显示 ${scrollOffset+1}-${Math.min(scrollOffset+maxVisible, fields.length)} / ${fields.length}
            <button id="scroll-up" style="margin:0 4px">↑</button>
            <button id="scroll-down" style="margin:0 4px">↓</button>
          </div>
        ` : ''}
      </div>
      <div class="node-editor-footer">
        <button id="btn-add-field">+ 添加字段</button>
        <button id="btn-close-editor">完成</button>
      </div>
    `;

    this.bindEditorEvents(node, editor);
  }

  bindEditorEvents(node, editor) {
    const nameInput = editor.querySelector('#edit-table-name');
    nameInput.addEventListener('change', () => {
      const oldName = node.name;
      const newName = nameInput.value.trim();
      this.history.record({
        description: `重命名表 ${oldName} → ${newName}`,
        forward: () => this.doc.updateNode(node.id, { name: newName }),
        backward: () => this.doc.updateNode(node.id, { name: oldName })
      });
      this.doc.updateNode(node.id, { name: newName });
      this.broadcastChanges();
      this.renderer.requestRender();
    });

    editor.querySelectorAll('.field-row').forEach(row => {
      const idx = parseInt(row.dataset.index);
      const nameEl = row.querySelector('.field-name');
      const typeEl = row.querySelector('.field-type');

      nameEl.addEventListener('change', () => {
        this.updateField(node.id, idx, { name: nameEl.value.trim() });
      });

      typeEl.addEventListener('change', () => {
        this.updateField(node.id, idx, { type: typeEl.value });
      });

      row.querySelectorAll('.field-badge').forEach(badge => {
        badge.addEventListener('click', () => {
          const toggle = badge.dataset.toggle;
          const field = node.fields[idx];
          if (toggle === 'pk') this.updateField(node.id, idx, { isPK: !field.isPK });
          if (toggle === 'nn') this.updateField(node.id, idx, { notNull: !field.notNull });
          if (toggle === 'fk') this.updateField(node.id, idx, { isFK: !field.isFK });
        });
      });

      row.querySelector('.field-delete').addEventListener('click', () => {
        this.removeField(node.id, idx);
      });
    });

    editor.querySelector('#btn-add-field')?.addEventListener('click', () => {
      this.addField(node.id);
    });

    editor.querySelector('#btn-close-editor')?.addEventListener('click', () => {
      this.closeNodeEditor();
    });

    const scrollUp = editor.querySelector('#scroll-up');
    const scrollDown = editor.querySelector('#scroll-down');
    if (scrollUp) {
      scrollUp.addEventListener('click', () => {
        const state = this.renderer.virtualScrollState.get(node.id) || { offset: 0 };
        state.offset = Math.max(0, state.offset - 5);
        this.renderer.virtualScrollState.set(node.id, state);
        this.renderNodeEditor(this.doc.nodes.get(node.id), editor);
        this.renderer.requestRender();
      });
    }
    if (scrollDown) {
      scrollDown.addEventListener('click', () => {
        const state = this.renderer.virtualScrollState.get(node.id) || { offset: 0 };
        state.offset = Math.min(node.fields.length - 15, state.offset + 5);
        this.renderer.virtualScrollState.set(node.id, state);
        this.renderNodeEditor(this.doc.nodes.get(node.id), editor);
        this.renderer.requestRender();
      });
    }
  }

  updateField(nodeId, fieldIndex, updates) {
    const node = this.doc.nodes.get(nodeId);
    if (!node || !node.fields[fieldIndex]) return;

    const oldField = { ...node.fields[fieldIndex] };
    node.fields[fieldIndex] = { ...oldField, ...updates };

    this.history.record({
      description: `更新字段 ${oldField.name}`,
      forward: () => {
        const n = this.doc.nodes.get(nodeId);
        n.fields[fieldIndex] = { ...n.fields[fieldIndex], ...updates };
        this.doc.updateNode(nodeId, n);
      },
      backward: () => {
        const n = this.doc.nodes.get(nodeId);
        n.fields[fieldIndex] = oldField;
        this.doc.updateNode(nodeId, n);
      }
    });

    this.doc.updateNode(nodeId, node);
    this.broadcastChanges();
    this.renderer.requestRender();

    const editor = document.getElementById('node-editor');
    if (editor.style.display !== 'none') {
      this.renderNodeEditor(this.doc.nodes.get(nodeId), editor);
    }
  }

  addField(nodeId) {
    const node = this.doc.nodes.get(nodeId);
    if (!node) return;

    const field = {
      id: this.generateId(),
      name: `field_${(node.fields?.length || 0) + 1}`,
      type: 'TEXT',
      isPK: false,
      notNull: false,
      isFK: false,
      fkRef: null
    };

    if (!node.fields) node.fields = [];
    node.fields.push(field);

    this.history.record({
      description: `添加字段 ${field.name}`,
      forward: () => {
        const n = this.doc.nodes.get(nodeId);
        n.fields.push(field);
        this.doc.updateNode(nodeId, n);
      },
      backward: () => {
        const n = this.doc.nodes.get(nodeId);
        n.fields = n.fields.filter(f => f.id !== field.id);
        this.doc.updateNode(nodeId, n);
      }
    });

    this.doc.updateNode(nodeId, node);
    this.broadcastChanges();
    this.renderer.requestRender();

    const editor = document.getElementById('node-editor');
    if (editor.style.display !== 'none') {
      this.renderNodeEditor(this.doc.nodes.get(nodeId), editor);
    }
  }

  removeField(nodeId, fieldIndex) {
    const node = this.doc.nodes.get(nodeId);
    if (!node || !node.fields[fieldIndex]) return;

    const removed = node.fields[fieldIndex];
    node.fields.splice(fieldIndex, 1);

    this.history.record({
      description: `删除字段 ${removed.name}`,
      forward: () => {
        const n = this.doc.nodes.get(nodeId);
        n.fields = n.fields.filter(f => f.id !== removed.id);
        this.doc.updateNode(nodeId, n);
      },
      backward: () => {
        const n = this.doc.nodes.get(nodeId);
        n.fields.splice(fieldIndex, 0, removed);
        this.doc.updateNode(nodeId, n);
      }
    });

    this.doc.updateNode(nodeId, node);
    this.broadcastChanges();
    this.renderer.requestRender();

    const editor = document.getElementById('node-editor');
    if (editor.style.display !== 'none') {
      this.renderNodeEditor(this.doc.nodes.get(nodeId), editor);
    }
  }

  closeNodeEditor() {
    this.editingNode = null;
    document.getElementById('node-editor').style.display = 'none';
  }

  getTypeOptions(current) {
    const types = ['INTEGER', 'BIGINT', 'TEXT', 'VARCHAR', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'FLOAT', 'DOUBLE', 'DECIMAL', 'BLOB', 'JSON', 'UUID'];
    return types.map(t => `<option value="${t}" ${t === current ? 'selected' : ''}>${t}</option>`).join('');
  }

  // === UI: Properties Panel ===

  showProperties(node) {
    const panel = document.getElementById('properties-panel');
    const content = document.getElementById('properties-content');
    panel.style.display = 'block';
    content.innerHTML = `
      <div style="font-size:12px">
        <p><strong>${this.escapeHtml(node.name)}</strong></p>
        <p style="color:#a0a0b0">字段数: ${node.fields?.length || 0}</p>
        <p style="color:#a0a0b0">位置: (${Math.round(node.x)}, ${Math.round(node.y)})</p>
        <p style="color:#a0a0b0;margin-top:8px">双击编辑节点</p>
      </div>
    `;
  }

  showEdgeProperties(edge) {
    const panel = document.getElementById('properties-panel');
    const content = document.getElementById('properties-content');
    panel.style.display = 'block';

    const state = this.doc.getState();
    const source = state.nodes.find(n => n.id === edge.sourceId);
    const target = state.nodes.find(n => n.id === edge.targetId);

    content.innerHTML = `
      <div style="font-size:12px">
        <p><strong>关系</strong></p>
        <p>${this.escapeHtml(source?.name || '?')} → ${this.escapeHtml(target?.name || '?')}</p>
        <div style="margin-top:8px">
          <label style="display:block;margin-bottom:4px">源端基数:</label>
          <select id="edit-source-card" style="width:100%;padding:4px;background:#0f3460;border:1px solid #2a2a4a;color:#eaeaea;border-radius:3px">
            ${this.getCardinalityOptions(edge.sourceCardinality || '1..1')}
          </select>
        </div>
        <div style="margin-top:8px">
          <label style="display:block;margin-bottom:4px">目标端基数:</label>
          <select id="edit-target-card" style="width:100%;padding:4px;background:#0f3460;border:1px solid #2a2a4a;color:#eaeaea;border-radius:3px">
            ${this.getCardinalityOptions(edge.targetCardinality || '0..n')}
          </select>
        </div>
      </div>
    `;

    document.getElementById('edit-source-card').addEventListener('change', (e) => {
      this.updateEdgeCardinality(edge.id, 'sourceCardinality', e.target.value);
    });
    document.getElementById('edit-target-card').addEventListener('change', (e) => {
      this.updateEdgeCardinality(edge.id, 'targetCardinality', e.target.value);
    });
  }

  updateEdgeCardinality(edgeId, field, value) {
    const validation = this.cardinalityChecker.isValidTransition(null, value, [], null);
    if (!validation.valid) {
      this.showToast(validation.reason, 'error');
      return;
    }

    const edge = this.doc.edges.get(edgeId);
    if (!edge) return;

    const oldValue = edge[field];
    this.history.record({
      description: `修改基数 ${field}: ${oldValue} → ${value}`,
      forward: () => this.doc.updateEdge(edgeId, { [field]: value }),
      backward: () => this.doc.updateEdge(edgeId, { [field]: oldValue })
    });

    this.doc.updateEdge(edgeId, { [field]: value });
    this.broadcastChanges();
    this.renderer.requestRender();
    this.checkConstraints();
  }

  getCardinalityOptions(current) {
    const options = ['0..1', '1..1', '0..n', '1..n'];
    return options.map(o => `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('');
  }

  hideProperties() {
    document.getElementById('properties-panel').style.display = 'none';
  }

  showWarnings(warnings) {
    const panel = document.getElementById('constraint-warnings');
    const content = document.getElementById('warnings-content');

    if (warnings.length === 0) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    content.innerHTML = warnings.map(w => `
      <div class="warning-item">
        <div>${this.escapeHtml(w.message)}</div>
        ${w.suggestion ? `<div class="suggestion">💡 ${this.escapeHtml(w.suggestion)}</div>` : ''}
      </div>
    `).join('');
  }

  // === Toolbar ===

  initToolbar() {
    document.getElementById('btn-undo').addEventListener('click', () => this.undo());
    document.getElementById('btn-redo').addEventListener('click', () => this.redo());
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      this.renderer.viewport.zoomTo(this.renderer.viewport.zoom * 1.2, this.canvas.width / 4, this.canvas.height / 4);
      this.renderer.requestRender();
      this.updateZoomDisplay();
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      this.renderer.viewport.zoomTo(this.renderer.viewport.zoom / 1.2, this.canvas.width / 4, this.canvas.height / 4);
      this.renderer.requestRender();
      this.updateZoomDisplay();
    });
    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
      const state = this.doc.getState();
      this.renderer.viewport.fitToContent(state.nodes);
      this.renderer.requestRender();
      this.updateZoomDisplay();
    });
    document.getElementById('btn-save').addEventListener('click', () => this.save());
    document.getElementById('btn-export').addEventListener('click', () => this.exportFile());
    document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-input').click());
    document.getElementById('file-input').addEventListener('change', (e) => this.importFile(e));
    document.getElementById('btn-branch').addEventListener('click', () => this.showModal('modal-branch'));
    document.getElementById('btn-history').addEventListener('click', () => this.showHistoryModal());
    document.getElementById('btn-connect').addEventListener('click', () => this.showModal('modal-connect'));
  }

  updateToolbarState() {
    document.getElementById('btn-undo').disabled = !this.history.canUndo();
    document.getElementById('btn-redo').disabled = !this.history.canRedo();
  }

  updateZoomDisplay() {
    document.getElementById('zoom-level').textContent =
      Math.round(this.renderer.viewport.zoom * 100) + '%';
  }

  // === Sidebar ===

  initSidebar() {
    const paletteItem = document.querySelector('.palette-item');
    paletteItem.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'table');
      e.dataTransfer.effectAllowed = 'copy';
    });
  }

  // === Modals ===

  initModals() {
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').style.display = 'none';
      });
    });

    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
      });
    });

    document.getElementById('btn-new-branch').addEventListener('click', () => {
      const name = prompt('分支名称:');
      if (name) {
        const branch = this.versionControl.createBranch(name);
        if (branch) {
          this.showToast(`分支 "${name}" 已创建`);
          this.renderBranches();
        } else {
          this.showToast('分支已存在', 'error');
        }
      }
    });

    document.getElementById('btn-merge-branch').addEventListener('click', () => {
      const branches = this.versionControl.getBranches()
        .filter(b => b.name !== this.versionControl.currentBranch);
      if (branches.length === 0) {
        this.showToast('没有可合并的分支', 'warning');
        return;
      }
      const name = prompt(`合并哪个分支到 ${this.versionControl.currentBranch}?\n可选: ${branches.map(b => b.name).join(', ')}`);
      if (name) {
        const result = this.versionControl.mergeBranch(name);
        if (result.success) {
          this.showToast('合并成功');
          this.renderer.requestRender();
        } else if (result.conflicts) {
          this.showConflictModal(result.conflicts, result.sourceState);
        } else {
          this.showToast(result.error, 'error');
        }
      }
    });

    document.getElementById('btn-gen-room').addEventListener('click', () => {
      const id = 'room_' + Math.random().toString(36).substr(2, 8);
      document.getElementById('input-room-id').value = id;
    });

    document.getElementById('btn-join-room').addEventListener('click', () => {
      const roomId = document.getElementById('input-room-id').value.trim();
      if (!roomId) return;
      const success = this.collaboration.connect(roomId);
      if (success) {
        document.getElementById('connect-status').textContent = '已连接到: ' + roomId;
        document.getElementById('modal-connect').style.display = 'none';
      }
    });

    document.getElementById('btn-resolve-all').addEventListener('click', () => {
      this.applyConflictResolutions();
    });
  }

  showModal(id) {
    document.getElementById(id).style.display = 'flex';
    if (id === 'modal-branch') this.renderBranches();
  }

  renderBranches() {
    const list = document.getElementById('branch-list');
    const branches = this.versionControl.getBranches();

    list.innerHTML = branches.map(b => `
      <div class="branch-item ${b.name === this.versionControl.currentBranch ? 'active' : ''}">
        <span>${this.escapeHtml(b.name)} ${b.name === this.versionControl.currentBranch ? '(当前)' : ''}</span>
        <div>
          ${b.name !== this.versionControl.currentBranch ?
            `<button data-switch="${b.name}">切换</button>
             <button data-delete="${b.name}">删除</button>` : ''}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('[data-switch]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.versionControl.commit('自动保存: 切换分支前');
        this.versionControl.switchBranch(btn.dataset.switch);
        this.renderer.requestRender();
        this.renderBranches();
      });
    });

    list.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm(`确定删除分支 "${btn.dataset.delete}"?`)) {
          this.versionControl.deleteBranch(btn.dataset.delete);
          this.renderBranches();
        }
      });
    });
  }

  showHistoryModal() {
    this.showModal('modal-history');
    const list = document.getElementById('history-list');
    const history = this.history.getHistory();

    list.innerHTML = history.length === 0 ? '<p style="color:#a0a0b0;font-size:12px">暂无历史记录</p>' :
      history.reverse().map((h, i) => `
        <div class="history-item ${i === 0 ? 'current' : ''}" data-index="${h.index}">
          <div>${this.escapeHtml(h.description)}</div>
          <div class="time">${new Date(h.timestamp).toLocaleString()}</div>
        </div>
      `).join('');

    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        this.history.goToState(idx);
        this.renderer.requestRender();
        this.showHistoryModal();
      });
    });
  }

  showConflictModal(conflicts, sourceState) {
    this.pendingConflicts = conflicts;
    this.pendingSourceState = sourceState;
    document.getElementById('modal-conflict').style.display = 'flex';

    const list = document.getElementById('conflict-list');
    list.innerHTML = conflicts.map((c, i) => `
      <div class="conflict-item" data-index="${i}">
        <div class="conflict-header">节点: ${this.escapeHtml(c.nodeName)} (${c.nodeId.substr(0, 8)}...)</div>
        <div class="conflict-body">
          <div class="conflict-side local">
            <h4>当前版本</h4>
            ${this.renderConflictFields(c.current, c.changes)}
          </div>
          <div class="conflict-side imported">
            <h4>导入/合并版本</h4>
            ${this.renderConflictFields(c.source || c.imported, c.changes)}
          </div>
        </div>
        <div class="conflict-resolve">
          <button class="res-btn ${c.resolution === 'keep_current' ? 'selected' : ''}" data-idx="${i}" data-res="keep_current">保留当前</button>
          <button class="res-btn ${c.resolution === 'use_imported' ? 'selected' : ''}" data-idx="${i}" data-res="use_imported">使用导入</button>
          <button class="res-btn ${c.resolution === 'merge' ? 'selected' : ''}" data-idx="${i}" data-res="merge">合并两者</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.res-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        this.pendingConflicts[idx].resolution = btn.dataset.res;
        btn.parentElement.querySelectorAll('.res-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
  }

  renderConflictFields(node, changes) {
    if (!node) return '<p>节点不存在</p>';
    return (node.fields || []).map(f => {
      const change = changes?.find(c => c.field === (f.id || f.name));
      let cls = '';
      if (change) {
        if (change.type === 'added') cls = 'added';
        else if (change.type === 'removed') cls = 'removed';
        else if (change.type === 'modified') cls = 'modified';
      }
      return `<div class="field-diff ${cls}">${this.escapeHtml(f.name)}: ${f.type} ${f.isPK ? '[PK]' : ''} ${f.notNull ? '[NN]' : ''}</div>`;
    }).join('');
  }

  applyConflictResolutions() {
    if (!this.pendingConflicts) return;
    const resolutions = this.pendingConflicts.map(c => ({
      nodeId: c.nodeId,
      resolution: c.resolution || 'keep_current'
    }));

    const schema = this.pendingSourceState || { nodes: this.pendingConflicts.map(c => c.imported || c.source), edges: [] };
    applyImport(this.doc, schema, resolutions);

    this.pendingConflicts = null;
    this.pendingSourceState = null;
    document.getElementById('modal-conflict').style.display = 'none';
    this.renderer.requestRender();
    this.showToast('冲突已解决');
  }

  // === Import/Export ===

  exportFile() {
    const data = exportToJSON(this.doc, this.versionControl);
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quickdb_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.lastExportClock = this.doc.vectorClock.getTimestamp();
    this.showToast('已导出');
  }

  importFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        const result = importFromJSON(data, this.doc);

        if (!result.success && result.conflicts) {
          this.showConflictModal(result.conflicts, data.schema || data);
        } else {
          this.renderer.requestRender();
          this.showToast('导入成功');
        }
      } catch (err) {
        this.showToast('导入失败: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // === Collaboration ===

  initCollaboration() {
    this.collaboration.subscribe((event) => {
      switch (event.type) {
        case 'status':
          const indicator = document.getElementById('collab-indicator');
          const text = document.getElementById('collab-text');
          indicator.className = 'indicator ' + event.status;
          text.textContent = event.status === 'online' ? '已连接' : '离线';
          break;
        case 'peers':
          document.getElementById('peer-count').textContent =
            event.count > 0 ? `(${event.count} 位协作者)` : '';
          break;
        case 'cursors':
          this.renderer.requestRender();
          break;
      }
    });

    this.doc.subscribe((op) => {
      if (op.type === 'state_sync') {
        this.renderer.requestRender();
      }
    });
  }

  // === Utilities ===

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: ${type === 'error' ? '#f44336' : type === 'warning' ? '#ff9800' : '#4caf50'};
      color: white; padding: 8px 20px; border-radius: 6px; font-size: 13px;
      z-index: 9999; animation: fadeIn 0.2s;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }
}

const app = new QuickDBApp();
window.quickdb = app;
