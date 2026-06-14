export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.minZoom = 0.1;
    this.maxZoom = 5;
    this.isPanning = false;
    this.lastMouse = { x: 0, y: 0 };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.x) / this.zoom,
      y: (sy - this.y) / this.zoom
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: wx * this.zoom + this.x,
      y: wy * this.zoom + this.y
    };
  }

  zoomTo(newZoom, cx, cy) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    const scale = this.zoom / oldZoom;
    this.x = cx - (cx - this.x) * scale;
    this.y = cy - (cy - this.y) * scale;
  }

  pan(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  fitToContent(nodes, padding = 80) {
    if (nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    this.zoom = Math.min(cw / contentW, ch / contentH, 2);
    this.x = (cw - contentW * this.zoom) / 2 - (minX - padding) * this.zoom;
    this.y = (ch - contentH * this.zoom) / 2 - (minY - padding) * this.zoom;
  }

  getVisibleBounds() {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.canvas.width, this.canvas.height);
    return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  }
}

export class CanvasRenderer {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.viewport = new Viewport(canvas);
    this.animFrameId = null;
    this.needsRender = true;
    this.gridSize = 20;
    this.virtualScrollState = new Map();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const container = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = container.clientWidth * dpr;
    this.canvas.height = container.clientHeight * dpr;
    this.canvas.style.width = container.clientWidth + 'px';
    this.canvas.style.height = container.clientHeight + 'px';
    this.ctx.scale(dpr, dpr);
    this.needsRender = true;
  }

  startRenderLoop() {
    const render = () => {
      if (this.needsRender) {
        this.render();
        this.needsRender = false;
      }
      this.animFrameId = requestAnimationFrame(render);
    };
    render();
  }

  stopRenderLoop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
  }

  requestRender() {
    this.needsRender = true;
  }

  render() {
    const ctx = this.ctx;
    const vp = this.viewport;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    this.drawGrid(ctx, vp, w, h);

    ctx.translate(vp.x, vp.y);
    ctx.scale(vp.zoom, vp.zoom);

    const bounds = vp.getVisibleBounds();
    const state = this.app.doc.getState();

    this.drawEdges(ctx, state.edges, state.nodes, bounds);
    this.drawNodes(ctx, state.nodes, bounds);

    if (this.app.dragState?.type === 'create_edge') {
      this.drawTempEdge(ctx);
    }

    this.drawRemoteCursors(ctx);

    ctx.restore();

    if (this.app.selectionBox) {
      this.drawSelectionBox(ctx);
    }
  }

  drawGrid(ctx, vp, w, h) {
    const gridSize = this.gridSize;
    const zoomedGrid = gridSize * vp.zoom;

    if (zoomedGrid < 5) return;

    ctx.strokeStyle = '#1e2240';
    ctx.lineWidth = 0.5;

    const startX = vp.x % zoomedGrid;
    const startY = vp.y % zoomedGrid;

    ctx.beginPath();
    for (let x = startX; x < w; x += zoomedGrid) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = startY; y < h; y += zoomedGrid) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  drawNodes(ctx, nodes, bounds) {
    for (const node of nodes) {
      if (!this.isVisible(node, bounds)) continue;
      this.drawNode(ctx, node);
    }
  }

  drawNode(ctx, node) {
    const isSelected = this.app.selectedNodes.has(node.id);
    const x = node.x;
    const y = node.y;
    const w = node.width || 220;
    const headerH = 32;
    const fieldH = 24;
    const fields = node.fields || [];

    const maxVisibleFields = 15;
    const scrollState = this.virtualScrollState.get(node.id) || { offset: 0 };
    const visibleFields = fields.slice(scrollState.offset, scrollState.offset + maxVisibleFields);
    const hasScroll = fields.length > maxVisibleFields;

    const totalH = headerH + visibleFields.length * fieldH + (hasScroll ? 20 : 0);
    node.height = totalH;
    node.width = w;

    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;

    ctx.fillStyle = '#1e2a4a';
    ctx.strokeStyle = isSelected ? '#e94560' : '#3a5a8f';
    ctx.lineWidth = isSelected ? 2.5 : 1.5;

    this.roundRect(ctx, x, y, w, totalH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = 'transparent';

    ctx.fillStyle = '#2a3f6f';
    this.roundRectTop(ctx, x, y, w, headerH, 6);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name || '未命名表', x + 10, y + headerH / 2);

    ctx.fillStyle = '#a0a0b0';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${fields.length} 字段`, x + w - 10, y + headerH / 2);

    for (let i = 0; i < visibleFields.length; i++) {
      const field = visibleFields[i];
      const fy = y + headerH + i * fieldH;

      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.02)';
        ctx.fillRect(x, fy, w, fieldH);
      }

      ctx.strokeStyle = '#2a2a4a';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, fy + fieldH);
      ctx.lineTo(x + w, fy + fieldH);
      ctx.stroke();

      let badgeX = x + 8;
      ctx.font = '9px monospace';
      if (field.isPK) {
        ctx.fillStyle = '#ffd700';
        ctx.fillRect(badgeX, fy + 7, 18, 12);
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.fillText('PK', badgeX + 9, fy + 14);
        badgeX += 22;
      }
      if (field.isFK) {
        ctx.fillStyle = '#2196f3';
        ctx.fillRect(badgeX, fy + 7, 18, 12);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText('FK', badgeX + 9, fy + 14);
        badgeX += 22;
      }
      if (field.notNull) {
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(badgeX, fy + 7, 18, 12);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText('NN', badgeX + 9, fy + 14);
        badgeX += 22;
      }

      ctx.fillStyle = '#eaeaea';
      ctx.font = '12px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(field.name || 'field', badgeX + 4, fy + fieldH / 2 + 1);

      ctx.fillStyle = '#6a8abf';
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(field.type || 'TEXT', x + w - 10, fy + fieldH / 2 + 1);
    }

    if (hasScroll) {
      const scrollY = y + headerH + visibleFields.length * fieldH;
      ctx.fillStyle = '#2a2a4a';
      ctx.fillRect(x, scrollY, w, 20);
      ctx.fillStyle = '#a0a0b0';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`↕ ${scrollState.offset + 1}-${scrollState.offset + visibleFields.length} / ${fields.length}`, x + w / 2, scrollY + 12);
    }
  }

  drawEdges(ctx, edges, nodes, bounds) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const router = this.app.router;

    for (const edge of edges) {
      const source = nodeMap.get(edge.sourceId);
      const target = nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      const sourceRect = { x: source.x, y: source.y, width: source.width || 220, height: source.height || 60 };
      const targetRect = { x: target.x, y: target.y, width: target.width || 220, height: target.height || 60 };

      const { startSide, endSide } = router.getBestConnectionSide(sourceRect, targetRect);
      const startPt = router.getConnectionPoint(sourceRect, startSide);
      const endPt = router.getConnectionPoint(targetRect, endSide);

      const obstacles = nodes
        .map(n => ({ x: n.x, y: n.y, width: n.width || 220, height: n.height || 60 }));

      const points = router.route(startPt, endPt, startSide, endSide, obstacles);

      const isSelected = this.app.selectedEdge === edge.id;
      ctx.strokeStyle = isSelected ? '#e94560' : '#6a8abf';
      ctx.lineWidth = isSelected ? 2.5 : 1.8;
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();

      this.drawCardinality(ctx, points[0], startSide, edge.sourceCardinality || '1..1', isSelected);
      this.drawCardinality(ctx, points[points.length - 1], endSide, edge.targetCardinality || '0..n', isSelected);

      this.drawArrow(ctx, points[points.length - 2], points[points.length - 1], isSelected);
    }
  }

  drawCardinality(ctx, point, side, text, isSelected) {
    let tx = point.x, ty = point.y;
    const offset = 16;

    switch (side) {
      case 'left': tx -= offset; break;
      case 'right': tx += offset; break;
      case 'top': ty -= offset; break;
      case 'bottom': ty += offset; break;
    }

    ctx.fillStyle = isSelected ? '#e94560' : '#a0a0b0';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(26,26,46,0.8)';
    const metrics = ctx.measureText(text);
    ctx.fillRect(tx - metrics.width / 2 - 3, ty - 7, metrics.width + 6, 14);

    ctx.fillStyle = isSelected ? '#e94560' : '#fff';
    ctx.fillText(text, tx, ty);
  }

  drawArrow(ctx, from, to, isSelected) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 8;

    ctx.fillStyle = isSelected ? '#e94560' : '#6a8abf';
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  drawTempEdge(ctx) {
    const ds = this.app.dragState;
    if (!ds || ds.type !== 'create_edge') return;

    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(ds.startX, ds.startY);
    ctx.lineTo(ds.currentX, ds.currentY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawRemoteCursors(ctx) {
    const cursors = this.app.collaboration?.cursorPositions;
    if (!cursors) return;

    const colors = ['#ff6b6b', '#51cf66', '#339af0', '#ffd43b', '#cc5de8'];
    let i = 0;
    for (const [siteId, pos] of cursors) {
      const color = colors[i % colors.length];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x + 4, pos.y + 14);
      ctx.lineTo(pos.x + 10, pos.y + 10);
      ctx.closePath();
      ctx.fill();
      i++;
    }
  }

  drawSelectionBox(ctx) {
    const box = this.app.selectionBox;
    if (!box) return;

    ctx.save();
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.fillStyle = 'rgba(233,69,96,0.1)';

    const x = Math.min(box.startX, box.endX);
    const y = Math.min(box.startY, box.endY);
    const w = Math.abs(box.endX - box.startX);
    const h = Math.abs(box.endY - box.startY);

    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  isVisible(node, bounds) {
    const w = node.width || 220;
    const h = node.height || 60;
    return !(node.x + w < bounds.x || node.x > bounds.x + bounds.width ||
             node.y + h < bounds.y || node.y > bounds.y + bounds.height);
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  roundRectTop(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  hitTestNode(worldX, worldY, nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const w = node.width || 220;
      const h = node.height || 60;
      if (worldX >= node.x && worldX <= node.x + w &&
          worldY >= node.y && worldY <= node.y + h) {
        return node;
      }
    }
    return null;
  }

  hitTestEdge(worldX, worldY, edges, nodes) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const router = this.app.router;
    const threshold = 8;

    for (const edge of edges) {
      const source = nodeMap.get(edge.sourceId);
      const target = nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      const sourceRect = { x: source.x, y: source.y, width: source.width || 220, height: source.height || 60 };
      const targetRect = { x: target.x, y: target.y, width: target.width || 220, height: target.height || 60 };
      const { startSide, endSide } = router.getBestConnectionSide(sourceRect, targetRect);
      const startPt = router.getConnectionPoint(sourceRect, startSide);
      const endPt = router.getConnectionPoint(targetRect, endSide);
      const obstacles = nodes
        .map(n => ({ x: n.x, y: n.y, width: n.width || 220, height: n.height || 60 }));

      const points = router.route(startPt, endPt, startSide, endSide, obstacles);

      for (let i = 0; i < points.length - 1; i++) {
        const dist = this.pointToSegmentDist(worldX, worldY, points[i], points[i + 1]);
        if (dist < threshold) return edge;
      }
    }
    return null;
  }

  pointToSegmentDist(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);

    let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + t * dx, y: a.y + t * dy };
    return Math.hypot(px - proj.x, py - proj.y);
  }

  hitTestFieldFK(worldX, worldY, node) {
    if (!node || !node.fields) return null;
    const headerH = 32;
    const fieldH = 24;
    const relY = worldY - node.y - headerH;
    if (relY < 0) return null;
    const fieldIdx = Math.floor(relY / fieldH);
    if (fieldIdx >= 0 && fieldIdx < node.fields.length) {
      const field = node.fields[fieldIdx];
      if (field.isFK) {
        const w = node.width || 220;
        if (worldX >= node.x + w - 30) {
          return { field, fieldIndex: fieldIdx };
        }
      }
    }
    return null;
  }
}
