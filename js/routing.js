export class OrthogonalRouter {
  constructor() {
    this.padding = 20;
    this.gridSize = 10;
  }

  route(startPoint, endPoint, startSide, endSide, obstacles) {
    const points = [];
    const sp = { x: startPoint.x, y: startPoint.y };
    const ep = { x: endPoint.x, y: endPoint.y };

    const startExt = this.extendPoint(sp, startSide, this.padding);
    const endExt = this.extendPoint(ep, endSide, this.padding);

    points.push(sp);
    points.push(startExt);

    const route = this.findOrthogonalPath(startExt, endExt, startSide, endSide, obstacles);
    points.push(...route);

    points.push(endExt);
    points.push(ep);

    return this.optimizePath(points, obstacles);
  }

  extendPoint(point, side, distance) {
    switch (side) {
      case 'left': return { x: point.x - distance, y: point.y };
      case 'right': return { x: point.x + distance, y: point.y };
      case 'top': return { x: point.x, y: point.y - distance };
      case 'bottom': return { x: point.x, y: point.y + distance };
    }
    return { ...point };
  }

  findOrthogonalPath(start, end, startSide, endSide, obstacles) {
    const points = [];
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    const startHorizontal = startSide === 'left' || startSide === 'right';
    const endHorizontal = endSide === 'left' || endSide === 'right';

    if (startHorizontal && endHorizontal) {
      if (Math.abs(dy) < 5) {
        return [];
      }
      const midX = start.x + dx / 2;
      let adjustedMidX = midX;
      for (const obs of obstacles) {
        if (this.lineIntersectsRect(midX, Math.min(start.y, end.y), midX, Math.max(start.y, end.y), obs)) {
          adjustedMidX = obs.x + obs.width + this.padding;
          if (adjustedMidX > Math.max(start.x, end.x)) {
            adjustedMidX = obs.x - this.padding;
          }
        }
      }
      points.push({ x: adjustedMidX, y: start.y });
      points.push({ x: adjustedMidX, y: end.y });
    } else if (!startHorizontal && !endHorizontal) {
      if (Math.abs(dx) < 5) {
        return [];
      }
      const midY = start.y + dy / 2;
      let adjustedMidY = midY;
      for (const obs of obstacles) {
        if (this.lineIntersectsRect(Math.min(start.x, end.x), midY, Math.max(start.x, end.x), midY, obs)) {
          adjustedMidY = obs.y + obs.height + this.padding;
          if (adjustedMidY > Math.max(start.y, end.y)) {
            adjustedMidY = obs.y - this.padding;
          }
        }
      }
      points.push({ x: start.x, y: adjustedMidY });
      points.push({ x: end.x, y: adjustedMidY });
    } else if (startHorizontal && !endHorizontal) {
      let corner = { x: end.x, y: start.y };
      let blocked = false;
      for (const obs of obstacles) {
        if (this.pointInRect(corner, obs)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        const midY = start.y + dy / 2;
        points.push({ x: start.x + dx / 2, y: start.y });
        points.push({ x: start.x + dx / 2, y: end.y });
      } else {
        points.push(corner);
      }
    } else {
      let corner = { x: start.x, y: end.y };
      let blocked = false;
      for (const obs of obstacles) {
        if (this.pointInRect(corner, obs)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        const midX = start.x + dx / 2;
        points.push({ x: start.x, y: start.y + dy / 2 });
        points.push({ x: end.x, y: start.y + dy / 2 });
      } else {
        points.push(corner);
      }
    }

    return points;
  }

  optimizePath(points, obstacles) {
    if (points.length <= 2) return points;

    const result = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = result[result.length - 1];
      const curr = points[i];
      const next = points[i + 1];

      const sameLine = (prev.x === curr.x && curr.x === next.x) ||
                       (prev.y === curr.y && curr.y === next.y);
      if (!sameLine) {
        result.push(curr);
      }
    }
    result.push(points[points.length - 1]);

    return this.adjustForOverlaps(result, obstacles);
  }

  adjustForOverlaps(points, obstacles) {
    const adjusted = [...points];

    for (let i = 1; i < adjusted.length - 1; i++) {
      const p = adjusted[i];
      for (const obs of obstacles) {
        if (this.pointInRect(p, obs)) {
          const distances = [
            { dir: 'left', dist: p.x - obs.x, newX: obs.x - this.padding, newY: p.y },
            { dir: 'right', dist: obs.x + obs.width - p.x, newX: obs.x + obs.width + this.padding, newY: p.y },
            { dir: 'top', dist: p.y - obs.y, newX: p.x, newY: obs.y - this.padding },
            { dir: 'bottom', dist: obs.y + obs.height - p.y, newX: p.x, newY: obs.y + obs.height + this.padding },
          ];
          distances.sort((a, b) => a.dist - b.dist);
          adjusted[i] = { x: distances[0].newX, y: distances[0].newY };
          break;
        }
      }
    }

    return adjusted;
  }

  lineIntersectsRect(x1, y1, x2, y2, rect) {
    const rx = rect.x - this.padding / 2;
    const ry = rect.y - this.padding / 2;
    const rw = rect.width + this.padding;
    const rh = rect.height + this.padding;

    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    return !(maxX < rx || minX > rx + rw || maxY < ry || minY > ry + rh);
  }

  pointInRect(point, rect) {
    return point.x >= rect.x && point.x <= rect.x + rect.width &&
           point.y >= rect.y && point.y <= rect.y + rect.height;
  }

  getBestConnectionSide(sourceRect, targetRect) {
    const sc = { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height / 2 };
    const tc = { x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 };

    const dx = tc.x - sc.x;
    const dy = tc.y - sc.y;

    let startSide, endSide;

    if (Math.abs(dx) > Math.abs(dy)) {
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
      case 'left': return { x: rect.x, y: rect.y + rect.height / 2 };
      case 'right': return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      case 'top': return { x: rect.x + rect.width / 2, y: rect.y };
      case 'bottom': return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    }
  }
}

export class CardinalityChecker {
  constructor() {
    this.validCardinalities = ['0..1', '1..1', '0..n', '1..n', 'n..m'];
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

      for (let i = 0; i < connections.length; i++) {
        for (let j = i + 1; j < connections.length; j++) {
          const a = connections[i];
          const b = connections[j];
          const conflict = this.checkPairConflict(a, b, node);
          if (conflict) {
            warnings.push({
              nodeId,
              nodeName: node.name,
              message: conflict.message,
              suggestion: conflict.suggestion,
              edges: [a.edge.id, b.edge.id]
            });
          }
        }
      }
    }

    for (const edge of edges) {
      const sourceCard = this.parseCardinality(edge.sourceCardinality || '1..1');
      const targetCard = this.parseCardinality(edge.targetCardinality || '0..n');

      if (sourceCard && targetCard) {
        if (sourceCard.min === '1' && targetCard.min === '1') {
          const sourceNode = nodes.find(n => n.id === edge.sourceId);
          const targetNode = nodes.find(n => n.id === edge.targetId);
          if (sourceNode && targetNode) {
            const sourceHasFK = sourceNode.fields?.some(f => f.fkRef === targetNode.id);
            const targetHasFK = targetNode.fields?.some(f => f.fkRef === sourceNode.id);
            if (!sourceHasFK && !targetHasFK) {
              warnings.push({
                nodeId: edge.sourceId,
                nodeName: sourceNode.name,
                message: `1..1 关系要求 ${sourceNode.name} 或 ${targetNode.name} 拥有外键引用`,
                suggestion: `建议在 ${sourceNode.name} 中添加指向 ${targetNode.name} 的外键字段`,
                edges: [edge.id]
              });
            }
          }
        }
      }
    }

    return warnings;
  }

  checkPairConflict(a, b, node) {
    const aCard = a.role === 'source'
      ? a.edge.sourceCardinality
      : a.edge.targetCardinality;
    const bCard = b.role === 'source'
      ? b.edge.sourceCardinality
      : b.edge.targetCardinality;

    if (!aCard || !bCard) return null;

    const aParsed = this.parseCardinality(aCard);
    const bParsed = this.parseCardinality(bCard);

    if (!aParsed || !bParsed) return null;

    if (aParsed.max === '1' && bParsed.max === '1') {
      if (aParsed.min === '1' && bParsed.min === '1') {
        return {
          message: `${node.name} 被两个关系同时要求为强制一对一参与方，可能产生冲突`,
          suggestion: `考虑将其中一个关系的基数改为 0..1`
        };
      }
    }

    return null;
  }

  isValidTransition(oldCard, newCard, edges, nodeId) {
    const parsed = this.parseCardinality(newCard);
    if (!parsed) return { valid: false, reason: '无效的基数格式' };

    if (!this.validCardinalities.includes(newCard)) {
      return { valid: false, reason: `不支持的基数: ${newCard}，支持: ${this.validCardinalities.join(', ')}` };
    }

    return { valid: true };
  }
}
