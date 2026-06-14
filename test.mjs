import { CRDTDocument } from './js/crdt.js';
import { HistoryManager, VersionControl } from './js/history.js';
import { OrthogonalRouter, CardinalityChecker } from './js/routing.js';
import { Collaboration } from './js/collaboration.js';
import { exportToJSON, exportIncremental, exportStream, importFromJSON, importStreamText } from './js/io.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}

// === Test 1: Overlapping nodes - route must NOT pass through either node ===
console.log('\n=== Test 1: Overlapping nodes routing ===');
{
  const router = new OrthogonalRouter();

  // Two overlapping nodes
  const sourceRect = { x: 100, y: 100, width: 220, height: 80 };
  const targetRect = { x: 150, y: 120, width: 220, height: 80 }; // heavily overlapping

  const { startSide, endSide } = router.getBestConnectionSide(sourceRect, targetRect);
  const startPt = router.getConnectionPoint(sourceRect, startSide);
  const endPt = router.getConnectionPoint(targetRect, endSide);

  // ALL nodes are obstacles (including source and target)
  const obstacles = [sourceRect, targetRect];
  const points = router.route(startPt, endPt, startSide, endSide, obstacles);

  assert(points.length >= 4, `Route has waypoints (${points.length} points)`);

  // Check intermediate segments don't pass through either node
  let passesThrough = false;
  // Skip first segment (sp→ext1) and last segment (ext2→ep) since those exit/enter nodes
  for (let i = 1; i < points.length - 2; i++) {
    if (router.segmentIntersectsRect(points[i].x, points[i].y, points[i+1].x, points[i+1].y, sourceRect)) {
      passesThrough = true;
      console.error(`    Segment ${i}-${i+1} passes through source:`, points[i], points[i+1]);
    }
    if (router.segmentIntersectsRect(points[i].x, points[i].y, points[i+1].x, points[i+1].y, targetRect)) {
      passesThrough = true;
      console.error(`    Segment ${i}-${i+1} passes through target:`, points[i], points[i+1]);
    }
  }
  assert(!passesThrough, 'Intermediate segments avoid BOTH overlapping nodes');

  // Test nearly overlapping (gap < padding)
  const sr2 = { x: 0, y: 0, width: 220, height: 80 };
  const tr2 = { x: 225, y: 10, width: 220, height: 80 }; // 5px gap only
  const { startSide: ss2, endSide: es2 } = router.getBestConnectionSide(sr2, tr2);
  const sp2 = router.getConnectionPoint(sr2, ss2);
  const ep2 = router.getConnectionPoint(tr2, es2);
  const pts2 = router.route(sp2, ep2, ss2, es2, [sr2, tr2]);
  assert(pts2.length >= 2, `Near-overlap route has points (${pts2.length})`);

  // Extension point pushed out of obstacle
  const ext = router.pushOutOfObstacles({ x: 200, y: 50 }, 'right', [{ x: 0, y: 0, width: 220, height: 80 }]);
  assert(ext.x >= 220 + router.padding, `Extension pushed out: x=${ext.x} >= ${220 + router.padding}`);
}

// === Test 2: Branch merge carries non-conflict edits ===
console.log('\n=== Test 2: Non-conflict merge changes applied ===');
{
  const doc = new CRDTDocument('site_merge');
  const vc = new VersionControl(doc);

  // Setup: create two nodes on main
  doc.addNode({ id: 'm1', name: 'users', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'mf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]});
  doc.addNode({ id: 'm2', name: 'orders', x: 300, y: 0, width: 220, height: 80, fields: [
    { id: 'mf2', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]});
  vc.commit('initial with users and orders');

  // Create feature branch and modify 'users' there (add email field)
  vc.createBranch('feature');
  vc.switchBranch('feature');
  const featureUsers = doc.nodes.get('m1');
  featureUsers.fields.push({ id: 'mf3', name: 'email', type: 'TEXT', isPK: false, notNull: true, isFK: false });
  featureUsers.name = 'accounts'; // rename too
  doc.updateNode('m1', featureUsers);
  // Also add a brand new node
  doc.addNode({ id: 'm3', name: 'products', x: 600, y: 0, width: 220, height: 80, fields: [] });
  vc.commit('feature: rename users→accounts, add email, add products');

  // Switch back to main - users should still be 'users' with no email
  vc.switchBranch('main');
  const mainUsers = doc.nodes.get('m1');
  assert(mainUsers.name === 'users', 'Main still has original name after branch switch');
  assert(mainUsers.fields.length === 1, 'Main still has 1 field');

  // Main didn't touch 'users', so merge should apply feature's changes
  // Main only modified 'orders' (non-conflicting)
  const mainOrders = doc.nodes.get('m2');
  mainOrders.fields.push({ id: 'mf4', name: 'total', type: 'DECIMAL', isPK: false, notNull: false, isFK: false });
  doc.updateNode('m2', mainOrders);
  vc.commit('main: add total field to orders');

  const result = vc.mergeBranch('feature');
  assert(result.success === true, 'Merge succeeded without conflicts');

  // Verify feature's non-conflict changes are in main
  const mergedUsers = doc.nodes.get('m1');
  assert(mergedUsers.name === 'accounts', `users renamed to accounts: got "${mergedUsers.name}"`);
  assert(mergedUsers.fields.length === 2, `users has 2 fields (id + email): got ${mergedUsers.fields.length}`);
  assert(mergedUsers.fields.some(f => f.name === 'email'), 'email field present');

  // New node from feature is also merged
  assert(doc.nodes.has('m3'), 'products node from feature branch merged in');

  // Main's own changes preserved
  const mergedOrders = doc.nodes.get('m2');
  assert(mergedOrders.fields.length === 2, `orders kept total field: got ${mergedOrders.fields.length}`);
}

// === Test 3: Concurrent paste name deduplication ===
console.log('\n=== Test 3: Concurrent paste deduplication ===');
{
  const doc1 = new CRDTDocument('site_P1');
  const doc2 = new CRDTDocument('site_P2');

  // Both start with a 'users' table
  const baseNode = { id: 'base1', name: 'users', x: 0, y: 0, width: 220, height: 80, fields: [] };
  doc1.addNode(baseNode);
  // Sync to doc2
  for (const op of doc1.getPendingOps()) doc2.applyRemoteOp(op);

  // Both paste 'users' concurrently → both generate 'users_copy1' locally
  const paste1 = { id: 'paste_A', name: 'users_copy1', x: 40, y: 40, width: 220, height: 80, fields: [] };
  const paste2 = { id: 'paste_B', name: 'users_copy1', x: 80, y: 80, width: 220, height: 80, fields: [] };
  doc1.addNode(paste1);
  doc2.addNode(paste2);

  // Now sync: doc1 sends to doc2 and vice versa
  const ops1 = doc1.getPendingOps();
  const ops2 = doc2.getPendingOps();
  for (const op of ops1) doc2.applyRemoteOp(op);
  for (const op of ops2) doc1.applyRemoteOp(op);

  // Both docs should have 3 nodes with unique names
  const state1 = doc1.getState();
  const state2 = doc2.getState();
  const names1 = state1.nodes.map(n => n.name).sort();
  const names2 = state2.nodes.map(n => n.name).sort();

  assert(state1.nodes.length === 3, `Doc1 has 3 nodes: got ${state1.nodes.length}`);
  assert(state2.nodes.length === 3, `Doc2 has 3 nodes: got ${state2.nodes.length}`);

  const uniqueNames1 = new Set(names1);
  const uniqueNames2 = new Set(names2);
  assert(uniqueNames1.size === 3, `Doc1 has 3 unique names: ${names1.join(', ')}`);
  assert(uniqueNames2.size === 3, `Doc2 has 3 unique names: ${names2.join(', ')}`);

  // Both docs agree on names (same set)
  assert(JSON.stringify(names1) === JSON.stringify(names2), `Both docs have same names: ${names1.join(',')} vs ${names2.join(',')}`);
}

// === Test 4: Concurrent field edits merge correctly ===
console.log('\n=== Test 4: Concurrent field edits converge ===');
{
  const doc1 = new CRDTDocument('site_F1');
  const doc2 = new CRDTDocument('site_F2');

  // Both start with a table having fields: id, name
  const node = { id: 'shared', name: 'users', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'f_id', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false },
    { id: 'f_name', name: 'name', type: 'TEXT', isPK: false, notNull: false, isFK: false }
  ]};
  doc1.addNode(JSON.parse(JSON.stringify(node)));
  const ops0 = doc1.getPendingOps();
  for (const op of ops0) doc2.applyRemoteOp(op);

  assert(doc2.nodes.get('shared')?.fields.length === 2, 'Doc2 starts with 2 fields');

  // Doc1 edits 'id' field → make it BIGINT
  const n1 = doc1.nodes.get('shared');
  n1.fields[0] = { ...n1.fields[0], type: 'BIGINT' };
  doc1.updateNode('shared', n1);

  // Doc2 edits 'name' field → make it notNull
  const n2 = doc2.nodes.get('shared');
  n2.fields[1] = { ...n2.fields[1], notNull: true };
  doc2.updateNode('shared', n2);

  // Exchange ops
  const ops1 = doc1.getPendingOps();
  const ops2 = doc2.getPendingOps();
  for (const op of ops2) doc1.applyRemoteOp(op);
  for (const op of ops1) doc2.applyRemoteOp(op);

  // Both should have: id=BIGINT, name=notNull:true
  const final1 = doc1.nodes.get('shared');
  const final2 = doc2.nodes.get('shared');

  assert(final1.fields.length === 2, `Doc1 has 2 fields: got ${final1.fields.length}`);
  assert(final2.fields.length === 2, `Doc2 has 2 fields: got ${final2.fields.length}`);

  const id1 = final1.fields.find(f => f.id === 'f_id');
  const id2 = final2.fields.find(f => f.id === 'f_id');
  const name1 = final1.fields.find(f => f.id === 'f_name');
  const name2 = final2.fields.find(f => f.id === 'f_name');

  assert(id1.type === 'BIGINT', `Doc1 id field is BIGINT: got ${id1.type}`);
  assert(id2.type === 'BIGINT', `Doc2 id field is BIGINT: got ${id2.type}`);
  assert(name1.notNull === true, `Doc1 name field is notNull: got ${name1.notNull}`);
  assert(name2.notNull === true, `Doc2 name field is notNull: got ${name2.notNull}`);

  // Verify final state is identical
  assert(JSON.stringify(final1.fields) === JSON.stringify(final2.fields),
    'Both docs have identical final field state');
}

// === Test 5: Adding a field in one doc while renaming in another ===
console.log('\n=== Test 5: Add field + rename converge ===');
{
  const doc1 = new CRDTDocument('site_X1');
  const doc2 = new CRDTDocument('site_X2');

  const node = { id: 'tbl', name: 'items', x: 0, y: 0, width: 220, height: 80, fields: [
    { id: 'xf1', name: 'id', type: 'INTEGER', isPK: true, notNull: true, isFK: false }
  ]};
  doc1.addNode(JSON.parse(JSON.stringify(node)));
  for (const op of doc1.getPendingOps()) doc2.applyRemoteOp(op);

  // Doc1: add a new field
  const n1 = doc1.nodes.get('tbl');
  n1.fields.push({ id: 'xf2', name: 'price', type: 'DECIMAL', isPK: false, notNull: false, isFK: false });
  doc1.updateNode('tbl', n1);

  // Doc2: rename table
  const n2 = doc2.nodes.get('tbl');
  doc2.updateNode('tbl', { ...n2, name: 'products' });

  // Sync
  const ops1 = doc1.getPendingOps();
  const ops2 = doc2.getPendingOps();
  for (const op of ops2) doc1.applyRemoteOp(op);
  for (const op of ops1) doc2.applyRemoteOp(op);

  const f1 = doc1.nodes.get('tbl');
  const f2 = doc2.nodes.get('tbl');

  // Both should have name='products' AND the 'price' field
  assert(f1.name === 'products', `Doc1 name = products: got "${f1.name}"`);
  assert(f2.name === 'products', `Doc2 name = products: got "${f2.name}"`);
  assert(f1.fields.length === 2, `Doc1 has 2 fields: got ${f1.fields.length}`);
  assert(f2.fields.length === 2, `Doc2 has 2 fields: got ${f2.fields.length}`);
  assert(f1.fields.some(f => f.name === 'price'), 'Doc1 has price field');
  assert(f2.fields.some(f => f.name === 'price'), 'Doc2 has price field');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
