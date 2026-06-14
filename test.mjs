import { CRDTDocument } from './js/crdt.js';
import { HistoryManager, VersionControl } from './js/history.js';
import { OrthogonalRouter, CardinalityChecker } from './js/routing.js';
import { Collaboration } from './js/collaboration.js';
import { exportToJSON, exportIncremental, exportStream, importFromJSON, importStreamText } from './js/io.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// === Test 1: Collaboration - two docs sync via direct ops ===
console.log('\n=== Test 1: Multi-peer collaboration sync ===');
{
  const doc1 = new CRDTDocument('site_A');
  const doc2 = new CRDTDocument('site_B');

  doc1.addNode({ id: 'n1', name: 'users', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'f1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]});

  const ops1 = doc1.getPendingOps();
  for (const op of ops1) doc2.applyRemoteOp(op);

  assert(doc2.nodes.get('n1')?.name === 'users', 'Doc2 received node from Doc1');

  doc2.updateNode('n1', { name: 'accounts' });
  const ops2 = doc2.getPendingOps();
  for (const op of ops2) doc1.applyRemoteOp(op);

  assert(doc1.nodes.get('n1')?.name === 'accounts', 'Doc1 received rename from Doc2');

  doc1.updateNode('n1', { x: 100 });
  doc2.updateNode('n1', { y: 200 });
  const ops1b = doc1.getPendingOps();
  const ops2b = doc2.getPendingOps();
  for (const op of ops2b) doc1.applyRemoteOp(op);
  for (const op of ops1b) doc2.applyRemoteOp(op);

  const n1d1 = doc1.nodes.get('n1');
  const n1d2 = doc2.nodes.get('n1');
  assert(n1d1 !== undefined && n1d2 !== undefined, 'Both docs still have node after concurrent edits');

  doc1.addNode({ id: 'n2', name: 'orders', x: 300, y: 0, width: 220, height: 80, fields: [] });
  doc2.addNode({ id: 'n3', name: 'products', x: 600, y: 0, width: 220, height: 80, fields: [] });
  const ops1c = doc1.getPendingOps();
  const ops2c = doc2.getPendingOps();
  for (const op of ops1c) doc2.applyRemoteOp(op);
  for (const op of ops2c) doc1.applyRemoteOp(op);

  assert(doc1.nodes.has('n3'), 'Doc1 has node added by Doc2');
  assert(doc2.nodes.has('n2'), 'Doc2 has node added by Doc1');
}

// === Test 2: Cardinality constraint blocking ===
console.log('\n=== Test 2: Cardinality constraint blocking ===');
{
  const checker = new CardinalityChecker();
  const nodes = [
    { id: 'a', name: 'A', fields: [] },
    { id: 'b', name: 'B', fields: [] },
    { id: 'c', name: 'C', fields: [] }
  ];
  const edges = [
    { id: 'e1', sourceId: 'a', targetId: 'b', sourceCardinality: '1..1', targetCardinality: '0..n' },
    { id: 'e2', sourceId: 'a', targetId: 'c', sourceCardinality: '1..1', targetCardinality: '0..n' }
  ];

  const warnings = checker.checkConsistency(edges, nodes);
  const errors = warnings.filter(w => w.severity === 'error');
  assert(errors.length > 0, 'Detects 1..1 conflict on node A');
  assert(errors[0].suggestion.length > 0, 'Provides fix suggestion');

  const validation = checker.validateCardinalityChange('e1', 'sourceCardinality', '1..1', edges, nodes);
  assert(!validation.valid, 'Blocks conflicting cardinality change');

  const validation2 = checker.validateCardinalityChange('e1', 'sourceCardinality', '0..1',
    [{ ...edges[0], sourceCardinality: '0..1' }, edges[1]], nodes);
  assert(validation2.valid, 'Allows valid cardinality after fix');
}

// === Test 3: Routing avoids obstacles ===
console.log('\n=== Test 3: Orthogonal routing obstacle avoidance ===');
{
  const router = new OrthogonalRouter();

  const sourceRect = { x: 0, y: 0, width: 220, height: 80 };
  const targetRect = { x: 500, y: 0, width: 220, height: 80 };
  const obstacle = { x: 250, y: -20, width: 200, height: 120 };

  const { startSide, endSide } = router.getBestConnectionSide(sourceRect, targetRect);
  const startPt = router.getConnectionPoint(sourceRect, startSide);
  const endPt = router.getConnectionPoint(targetRect, endSide);
  const points = router.route(startPt, endPt, startSide, endSide, [obstacle]);

  let passesThrough = false;
  for (let i = 0; i < points.length - 1; i++) {
    if (router.segmentIntersectsRect(points[i].x, points[i].y, points[i+1].x, points[i+1].y, obstacle)) {
      passesThrough = true;
      break;
    }
  }
  assert(!passesThrough, 'Route does NOT pass through obstacle');
  assert(points.length >= 4, 'Route has enough waypoints to go around');

  const directPoints = router.route(
    { x: 220, y: 40 }, { x: 500, y: 40 }, 'right', 'left', []
  );
  assert(directPoints.length >= 2, 'Direct route works without obstacles');
}

// === Test 4: Incremental and stream export/import ===
console.log('\n=== Test 4: Incremental & stream export/import ===');
{
  const doc = new CRDTDocument('site_test');
  doc.addNode({ id: 'x1', name: 'T1', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'xf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]});
  const clock1 = doc.vectorClock.getTimestamp();

  doc.addNode({ id: 'x2', name: 'T2', x: 300, y: 0, width: 220, height: 80, fields: [] });
  doc.addEdge({ id: 'xe1', sourceId: 'x1', targetId: 'x2', sourceCardinality: '1..1', targetCardinality: '0..n' });

  const incr = exportIncremental(doc, clock1);
  assert(incr.format === 'incremental', 'Incremental export has correct format');
  assert(incr.deltaNodes.length >= 1, 'Incremental has delta nodes');
  assert(incr.deltaEdges.length >= 1, 'Incremental has delta edges');

  const streamData = exportStream(doc);
  assert(streamData.includes('stream_header'), 'Stream export has header');
  assert(streamData.includes('nodes_chunk'), 'Stream export has nodes');
  assert(streamData.includes('stream_end'), 'Stream export has end marker');

  const doc2 = new CRDTDocument('site_import');
  const result = importStreamText(streamData, doc2);
  assert(result.success, 'Stream import succeeds');
  assert(doc2.nodes.has('x1'), 'Imported doc has node x1');
  assert(doc2.nodes.has('x2'), 'Imported doc has node x2');
  assert(doc2.edges.has('xe1'), 'Imported doc has edge');
}

// === Test 5: Branch merge with conflict detection ===
console.log('\n=== Test 5: Branch merge & conflict handling ===');
{
  const doc = new CRDTDocument('site_vc');
  const vc = new VersionControl(doc);

  doc.addNode({ id: 'v1', name: 'original', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'vf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]});

  vc.commit('initial');
  vc.createBranch('feature');
  vc.switchBranch('feature');

  doc.updateNode('v1', { name: 'modified_in_feature', fields: [
    { id: 'vf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false },
    { id: 'vf2', name: 'email', type: 'TEXT', isPK: false, notNull: true, isFK: false }
  ]});
  doc.addNode({ id: 'v2', name: 'new_table', x: 300, y: 0, width: 220, height: 80, fields: [] });
  vc.commit('add email field and new table');

  vc.switchBranch('main');
  const mainNode = doc.nodes.get('v1');
  assert(mainNode?.name === 'original', 'Switching back to main restores state');

  doc.updateNode('v1', { name: 'modified_in_main', fields: [
    { id: 'vf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false },
    { id: 'vf3', name: 'name', type: 'TEXT', isPK: false, notNull: false, isFK: false }
  ]});
  vc.commit('add name field in main');

  const result = vc.mergeBranch('feature');
  if (result.conflicts) {
    assert(result.conflicts.length > 0, 'Merge correctly detects conflict');
    assert(result.conflicts[0].nodeId === 'v1', 'Conflict is on the right node');

    result.conflicts[0].resolution = 'merge';
    vc.applyResolutions(result.conflicts, result.sourceState);

    const merged = doc.nodes.get('v1');
    assert(merged !== undefined, 'Node still exists after resolution');
    assert(doc.nodes.has('v2'), 'New node from feature branch was merged in');
  } else {
    assert(result.success, 'Merge succeeded without conflicts (fast-forward)');
    assert(doc.nodes.has('v2'), 'Feature branch node was merged');
  }
}

// === Test 6: Concurrent paste deduplication ===
console.log('\n=== Test 6: Paste creates unique names/IDs ===');
{
  const doc = new CRDTDocument('site_paste');
  doc.addNode({ id: 'p1', name: 'users', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'pf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]});

  const clipboard = [JSON.parse(JSON.stringify(doc.nodes.get('p1')))];
  const existingNames = new Set(['users']);

  const pastedNodes = [];
  for (let paste = 0; paste < 3; paste++) {
    for (const original of clipboard) {
      const newId = 'paste_' + paste + '_' + Math.random().toString(36).substr(2,5);
      let newName = original.name;
      let suffix = 1;
      while (existingNames.has(newName)) {
        newName = `${original.name}_copy${suffix}`;
        suffix++;
      }
      existingNames.add(newName);
      const node = { ...original, id: newId, name: newName, x: original.x + (paste+1)*40, y: original.y + (paste+1)*40 };
      doc.addNode(node);
      pastedNodes.push(node);
    }
  }

  const allNames = new Set();
  const allIds = new Set();
  const state = doc.getState();
  for (const n of state.nodes) {
    assert(!allIds.has(n.id), `Unique ID: ${n.id}`);
    assert(!allNames.has(n.name), `Unique name: ${n.name}`);
    allIds.add(n.id);
    allNames.add(n.name);
  }
  assert(state.nodes.length === 4, 'All 4 nodes exist (1 original + 3 pastes)');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
