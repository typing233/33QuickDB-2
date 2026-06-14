export class OrthogonalRouter {
  constructor() {
    this.padding = 24;
    this.gridSnap = 10;
  }

  route(startPoint, endPoint, startSide, endSide, obstacles) {
    const sp = { x: startPoint.x, y: startPoint.y };
    const ep = { x: endPoint.x, y: endPoint.y };
    const ext1 = this.extendPoint(sp, startSide, this.padding);
    const ext2 = this.extendPoint(ep, endSide, this.padding);

    const path = this.findPath(ext1, ext2, startSide, endSide, obstacles);

    return [sp, ext1, ...path, ext2, ep];
  }

  extendPoint(point, side, distance) {
    switch (side) {
      case 'left':   return { x: point.x - distance, y: point.y };
      case 'right':  return { x: point.x + distance, y: point.y };
      case 'top':    return { x: point.x, y: point.y - distance };
      case 'bottom': return { x: point.x, y: point.y + distance };
    }
    return { ...point };
  }

  findPath(start, end, startSide, endSide, obstacles) {
    const expandedObs = obstacles.map(o => ({
      x: o.x - this.padding,
      y: o.y - this.padding,
      width: o.width + this.padding * 2,
      height: o.height + this.padding * 2
    }));

    const candidates = this.buildCandidateLines(start, end, obstacles, expandedObs);
    const result = this.gridSearch(start, end, startSide, endSide, expandedObs, candidates);

    if (result.length > 0) return result;
    return this.fallbackRoute(start, end, startSide, endSide, obstacles);
  }

  buildCandidateLines(start, end, obstacles, expandedObs) {
    const hLines = new Set();
    const vLines = new Set();
    hLines.add(start.y);
    hLines.add(end.y);
    vLines.add(start.x);
    vLines.add(end.x);
    hLines.add((start.y + end.y) / 2);
    vLines.add((start.x + end.x) / 2);

    for (const obs of obstacles) {
      hLines.add(obs.y - this.padding);
      hLines.add(obs.y + obs.height + this.padding);
      vLines.add(obs.x - this.padding);
      vLines.add(obs.x + obs.width + this.padding);
    }

    return { hLines: [...hLines], vLines: [...vLines] };
  }

  gridSearch(start, end, startSide, endSide, expandedObs, candidates) {
    const startHoriz = (startSide === 'left' || startSide === 'right');
    const endHoriz = (endSide === 'left' || endSide === 'right');

    if (startHoriz && endHoriz) {
      return this.routeHH(start, end, expandedObs, candidates);
    } else if (!startHoriz && !endHoriz) {
      return this.routeVV(start, end, expandedObs, candidates);
    } else if (startHoriz && !endHoriz) {
      return this.routeHV(start, end, expandedObs, candidates);
    } else {
      return this.routeVH(start, end, expandedObs, candidates);
    }
  }

  routeHH(start, end, expandedObs, candidates) {
    if (Math.abs(start.y - end.y) < 2) {
      if (!this.segmentBlocked(start.x, start.y, end.x, start.y, expandedObs)) {
        return [];
      }
    }

    for (const vx of candidates.vLines) {
      if (!this.segmentBlocked(start.x, start.y, vx, start.y, expandedObs) &&
          !this.segmentBlocked(vx, start.y, vx, end.y, expandedObs) &&
          !this.segmentBlocked(vx, end.y, end.x, end.y, expandedObs)) {
        return [{ x: vx, y: start.y }, { x: vx, y: end.y }];
      }
    }

    for (const hy of candidates.hLines) {
      for (const vx of candidates.vLines) {
        if (!this.segmentBlocked(start.x, start.y, vx, start.y, expandedObs) &&
            !this.segmentBlocked(vx, start.y, vx, hy, expandedObs) &&
            !this.segmentBlocked(vx, hy, end.x, hy, expandedObs) &&
            !this.segmentBlocked(end.x, hy, end.x, end.y, expandedObs)) {
          return [{ x: vx, y: start.y }, { x: vx, y: hy }, { x: end.x, y: hy }];
        }
      }
    }

    return [];
  }

  routeVV(start, end, expandedObs, candidates) {
    if (Math.abs(start.x - end.x) < 2) {
      if (!this.segmentBlocked(start.x, start.y, start.x, end.y, expandedObs)) {
        return [];
      }
    }

    for (const hy of candidates.hLines) {
      if (!this.segmentBlocked(start.x, start.y, start.x, hy, expandedObs) &&
          !this.segmentBlocked(start.x, hy, end.x, hy, expandedObs) &&
          !this.segmentBlocked(end.x, hy, end.x, end.y, expandedObs)) {
        return [{ x: start.x, y: hy }, { x: end.x, y: hy }];
      }
    }

    for (const vx of candidates.vLines) {
      for (const hy of candidates.hLines) {
        if (!this.segmentBlocked(start.x, start.y, start.x, hy, expandedObs) &&
            !this.segmentBlocked(start.x, hy, vx, hy, expandedObs) &&
            !this.segmentBlocked(vx, hy, vx, end.y, expandedObs) &&
            !this.segmentBlocked(vx, end.y, end.x, end.y, expandedObs)) {
          return [{ x: start.x, y: hy }, { x: vx, y: hy }, { x: vx, y: end.y }];
        }
      }
    }

    return [];
  }

  routeHV(start, end, expandedObs, candidates) {
    const corner = { x: end.x, y: start.y };
    if (!this.segmentBlocked(start.x, start.y, corner.x, corner.y, expandedObs) &&
        !this.segmentBlocked(corner.x, corner.y, end.x, end.y, expandedObs)) {
      return [corner];
    }

    for (const vx of candidates.vLines) {
      if (!this.segmentBlocked(start.x, start.y, vx, start.y, expandedObs) &&
          !this.segmentBlocked(vx, start.y, vx, end.y, expandedObs) &&
          !this.segmentBlocked(vx, end.y, end.x, end.y, expandedObs)) {
        return [{ x: vx, y: start.y }, { x: vx, y: end.y }];
      }
    }

    for (const hy of candidates.hLines) {
      if (!this.segmentBlocked(start.x, start.y, end.x, start.y, expandedObs) &&
          !this.segmentBlocked(end.x, start.y, end.x, hy, expandedObs) &&
          !this.segmentBlocked(end.x, hy, end.x, end.y, expandedObs)) {
        return [{ x: end.x, y: start.y }, { x: end.x, y: hy }];
      }
    }

    return [corner];
  }

  routeVH(start, end, expandedObs, candidates) {
    const corner = { x: start.x, y: end.y };
    if (!this.segmentBlocked(start.x, start.y, corner.x, corner.y, expandedObs) &&
        !this.segmentBlocked(corner.x, corner.y, end.x, end.y, expandedObs)) {
      return [corner];
    }

    for (const hy of candidates.hLines) {
      if (!this.segmentBlocked(start.x, start.y, start.x, hy, expandedObs) &&
          !this.segmentBlocked(start.x, hy, end.x, hy, expandedObs) &&
          !this.segmentBlocked(end.x, hy, end.x, end.y, expandedObs)) {
        return [{ x: start.x, y: hy }, { x: end.x, y: hy }];
      }
    }

    for (const vx of candidates.vLines) {
      if (!this.segmentBlocked(start.x, start.y, start.x, end.y, expandedObs) &&
          !this.segmentBlocked(start.x, end.y, vx, end.y, expandedObs) &&
          !this.segmentBlocked(vx, end.y, end.x, end.y, expandedObs)) {
        return [{ x: start.x, y: end.y }, { x: vx, y: end.y }];
      }
    }

    return [corner];
  }

  fallbackRoute(start, end, startSide, endSide, obstacles) {
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const startHoriz = (startSide === 'left' || startSide === 'right');

    let bestPath = null;
    let bestCost = Infinity;

    const tryPath = (points) => {
      let cost = 0;
      let blocked = false;
      const allPts = [start, ...points, end];
      for (let i = 0; i < allPts.length - 1; i++) {
        const dx = Math.abs(allPts[i+1].x - allPts[i].x);
        const dy = Math.abs(allPts[i+1].y - allPts[i].y);
        cost += dx + dy;
        for (const obs of obstacles) {
          if (this.segmentIntersectsRect(allPts[i].x, allPts[i].y, allPts[i+1].x, allPts[i+1].y, obs)) {
            cost += 10000;
            blocked = true;
          }
        }
      }
      cost += points.length * 50;
      if (cost < bestCost) {
        bestCost = cost;
        bestPath = points;
      }
    };

    const offsets = [-80, -40, 0, 40, 80];
    for (const off of offsets) {
      if (startHoriz) {
        tryPath([{ x: midX + off, y: start.y }, { x: midX + off, y: end.y }]);
      } else {
        tryPath([{ x: start.x, y: midY + off }, { x: end.x, y: midY + off }]);
      }
    }

    for (const obs of obstacles) {
      const routes = [
        [{ x: obs.x - this.padding, y: start.y }, { x: obs.x - this.padding, y: end.y }],
        [{ x: obs.x + obs.width + this.padding, y: start.y }, { x: obs.x + obs.width + this.padding, y: end.y }],
        [{ x: start.x, y: obs.y - this.padding }, { x: end.x, y: obs.y - this.padding }],
        [{ x: start.x, y: obs.y + obs.height + this.padding }, { x: end.x, y: obs.y + obs.height + this.padding }],
      ];
      for (const r of routes) tryPath(r);
    }

    return bestPath || [{ x: midX, y: start.y }, { x: midX, y: end.y }];
  }

  segmentBlocked(x1, y1, x2, y2, expandedObs) {
    for (const obs of expandedObs) {
      if (this.segmentIntersectsRect(x1, y1, x2, y2, obs)) {
        return true;
      }
    }
    return false;
  }

  segmentIntersectsRect(x1, y1, x2, y2, rect) {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    if (maxX <= rect.x || minX >= rect.x + rect.width ||
        maxY <= rect.y || minY >= rect.y + rect.height) {
      return false;
    }

    const isHorizontal = (Math.abs(y1 - y2) < 0.1);
    const isVertical = (Math.abs(x1 - x2) < 0.1);

    if (isHorizontal) {
      return y1 > rect.y && y1 < rect.y + rect.height &&
             maxX > rect.x && minX < rect.x + rect.width;
    }
    if (isVertical) {
      return x1 > rect.x && x1 < rect.x + rect.width &&
             maxY > rect.y && minY < rect.y + rect.height;
    }

    return !(maxX <= rect.x || minX >= rect.x + rect.width ||
             maxY <= rect.y || minY >= rect.y + rect.height);
  }

  getBestConnectionSide(sourceRect, targetRect) {
    const sc = { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height / 2 };
    const tc = { x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 };

    const dx = tc.x - sc.x;
    const dy = tc.y - sc.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    let startSide, endSide;

    const gapX = absDx - (sourceRect.width + targetRect.width) / 2;
    const gapY = absDy - (sourceRect.height + targetRect.height) / 2;

    if (gapX > 0 && gapX >= gapY) {
      startSide = dx > 0 ? 'right' : 'left';
      endSide = dx > 0 ? 'left' : 'right';
    } else if (gapY > 0) {
      startSide = dy > 0 ? 'bottom' : 'top';
      endSide = dy > 0 ? 'top' : 'bottom';
    } else if (absDx > absDy) {
      startSide = dx > 0 ? 'right' : 'left';
      endSide = dx > 0 ? 'left' : 'right';
    } else {
      startSide = dy > 0 ? 'bottom' : 'top';
      endSide = dy > 0 ? 'top' : 'bottom';
    }

    return { startSide, endSide };
  }

  getConnectionPoint(rect, side) {
    switch (side) {
      case 'left':   return { x: rect.x, y: rect.y + rect.height / 2 };
      case 'right':  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      case 'top':    return { x: rect.x + rect.width / 2, y: rect.y };
      case 'bottom': return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    }
  }
}

export class CardinalityChecker {
  constructor() {
    this.validCardinalities = ['0..1', '1..1', '0..n', '1..n'];
  }

  parseCardinality(str) {
    const parts = str.split('..');
    if (parts.length !== 2) return null;
    return { min: parts[0], max: parts[1] };
  }

  checkConsistency(edges, nodes) {
    const warnings = [];
    const nodeEdgeMap = new Map();

    for (const edge of edges) {
      if (!nodeEdgeMap.has(edge.sourceId)) nodeEdgeMap.set(edge.sourceId, []);
      if (!nodeEdgeMap.has(edge.targetId)) nodeEdgeMap.set(edge.targetId, []);
      nodeEdgeMap.get(edge.sourceId).push({ edge, role: 'source' });
      nodeEdgeMap.get(edge.targetId).push({ edge, role: 'target' });
    }

    for (const [nodeId, connections] of nodeEdgeMap) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) continue;

      const mandatory1to1Count = connections.filter(c => {
        const card = c.role === 'source' ? c.edge.sourceCardinality : c.edge.targetCardinality;
        return card === '1..1';
      }).length;

      if (mandatory1to1Count > 1) {
        const conflictEdges = connections
          .filter(c => {
            const card = c.role === 'source' ? c.edge.sourceCardinality : c.edge.targetCardinality;
            return card === '1..1';
          })
          .map(c => c.edge.id);

        warnings.push({
          nodeId,
          nodeName: node.name,
          severity: 'error',
          message: `"${node.name}" 同时被 ${mandatory1to1Count} 个关系要求强制1..1参与，这些约束互相矛盾`,
          suggestion: `将其中 ${mandatory1to1Count - 1} 个关系的基数从 1..1 改为 0..1`,
          edges: conflictEdges
        });
      }

      const oneMaxConnections = connections.filter(c => {
        const card = c.role === 'source' ? c.edge.sourceCardinality : c.edge.targetCardinality;
        const parsed = this.parseCardinality(card || '0..n');
        return parsed && parsed.max === '1';
      });

      if (oneMaxConnections.length >= 2) {
        const allMandatory = oneMaxConnections.every(c => {
          const card = c.role === 'source' ? c.edge.sourceCardinality : c.edge.targetCardinality;
          return card === '1..1';
        });
        if (allMandatory) {
          const conflictEdges = oneMaxConnections.map(c => c.edge.id);
          warnings.push({
            nodeId,
            nodeName: node.name,
            severity: 'error',
            message: `"${node.name}" 被 ${oneMaxConnections.length} 个关系同时约束为max=1且必须参与，存在逻辑矛盾`,
            suggestion: `将部分关系改为 0..1 (可选参与) 或 0..n/1..n (多端)`,
            edges: conflictEdges
          });
        }
      }
    }

    for (const edge of edges) {
      const sourceCard = edge.sourceCardinality || '1..1';
      const targetCard = edge.targetCardinality || '0..n';
      const sc = this.parseCardinality(sourceCard);
      const tc = this.parseCardinality(targetCard);

      if (sc && tc && sc.min === '1' && sc.max === '1' && tc.min === '1' && tc.max === '1') {
        const sourceNode = nodes.find(n => n.id === edge.sourceId);
        const targetNode = nodes.find(n => n.id === edge.targetId);
        if (sourceNode && targetNode) {
          const srcHasFK = (sourceNode.fields || []).some(f => f.isFK && f.fkRef === targetNode.id);
          const tgtHasFK = (targetNode.fields || []).some(f => f.isFK && f.fkRef === sourceNode.id);
          if (!srcHasFK && !tgtHasFK) {
            warnings.push({
              nodeId: edge.sourceId,
              nodeName: sourceNode.name,
              severity: 'warning',
              message: `双向1..1关系(${sourceNode.name} ↔ ${targetNode.name})缺少外键字段来实现约束`,
              suggestion: `在 "${sourceNode.name}" 或 "${targetNode.name}" 中添加对方的外键字段，标记为 FK + UNIQUE`,
              edges: [edge.id]
            });
          }
        }
      }

      if (sc && tc && sc.max === 'n' && tc.max === 'n') {
        const sourceNode = nodes.find(n => n.id === edge.sourceId);
        const targetNode = nodes.find(n => n.id === edge.targetId);
        if (sourceNode && targetNode) {
          warnings.push({
            nodeId: edge.sourceId,
            nodeName: sourceNode.name,
            severity: 'warning',
            message: `多对多关系(${sourceNode.name} ↔ ${targetNode.name})通常需要中间表实现`,
            suggestion: `创建关联表 "${sourceNode.name}_${targetNode.name}" 包含双方外键`,
            edges: [edge.id]
          });
        }
      }
    }

    return warnings;
  }

  validateCardinalityChange(edgeId, field, newValue, allEdges, allNodes) {
    const parsed = this.parseCardinality(newValue);
    if (!parsed) return { valid: false, reason: '无效的基数格式', suggestions: [] };
    if (!this.validCardinalities.includes(newValue)) {
      return { valid: false, reason: `不支持的基数: ${newValue}`, suggestions: this.validCardinalities };
    }

    const simulatedEdges = allEdges.map(e => {
      if (e.id === edgeId) {
        return { ...e, [field]: newValue };
      }
      return e;
    });

    const errors = this.checkConsistency(simulatedEdges, allNodes)
      .filter(w => w.severity === 'error');

    if (errors.length > 0) {
      return {
        valid: false,
        reason: errors[0].message,
        suggestions: [errors[0].suggestion],
        errors
      };
    }

    return { valid: true };
  }

  hasBlockingErrors(edges, nodes) {
    const warnings = this.checkConsistency(edges, nodes);
    return warnings.filter(w => w.severity === 'error');
  }
}
