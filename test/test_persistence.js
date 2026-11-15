import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KVServer } from '../src/kv/server.js';
import { KVClient } from '../src/kv/client.js';
import { Persister } from '../src/raft/persister.js';
import { NetworkSimulator } from '../src/net/network_simulator.js';
import { sleep } from '../src/common/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DATA_DIR = path.join(__dirname, '../data/test_persistence');

export async function runPersistenceTests() {
  console.log('\n--- Running Disk Persistence & Crash Recovery Tests (MIT 6.824 Lab 2C) ---');

  // Clean test data directory
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const peers = [0, 1, 2];

  // 1. Initial run: Create servers with disk persistence
  console.log('Step 1: Starting cluster with file-backed disk storage...');
  let net = new NetworkSimulator();
  let servers = [];

  for (let i = 0; i < 3; i++) {
    const persister = new Persister(i, TEST_DATA_DIR);
    const s = new KVServer(i, peers, persister, {
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50
    });
    servers.push(s);
    net.registerNode(i, s);
  }

  await sleep(650);

  let client = new KVClient(servers, {
    sendHandler: async (idx, op) => {
      const s = servers[idx];
      if (!s || s.isKilled) throw new Error('Node down');
      if (op.type === 'GET') return await s.get(op.key, op.clientId, op.seq);
      if (op.type === 'PUT') return await s.put(op.key, op.value, op.clientId, op.seq);
      if (op.type === 'APPEND') return await s.append(op.key, op.value, op.clientId, op.seq);
    }
  });

  // Write committed state
  console.log('Step 2: Committing operations before power failure...');
  await client.put('service_status', 'PRODUCTION_ACTIVE');
  await client.put('db_version', 'v2.4.1');
  await client.append('audit_log', 'event:login;');
  await client.append('audit_log', 'event:payment;');

  const committedTerm = servers[client.knownLeader].raft.currentTerm;
  console.log(`  Committed at term: ${committedTerm}`);

  // 2. Simulate complete power outage (Kill all nodes and clear in-memory references)
  console.log('Step 3: Simulating catastrophic power outage (crashing ALL 3 servers simultaneously)...');
  servers.forEach(s => s.kill());
  servers = [];
  net = new NetworkSimulator();

  // Verify state files exist on disk
  for (let i = 0; i < 3; i++) {
    const stateFile = path.join(TEST_DATA_DIR, `raft-state-${i}.json`);
    assert.ok(fs.existsSync(stateFile), `State file for node ${i} should exist on disk`);
  }
  console.log('  ✓ Verified state files written to disk');

  await sleep(300);

  // 3. Reboot cluster from disk files
  console.log('Step 4: Rebooting cluster from disk files...');
  for (let i = 0; i < 3; i++) {
    const persister = new Persister(i, TEST_DATA_DIR);
    const s = new KVServer(i, peers, persister, {
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50
    });
    servers.push(s);
    net.registerNode(i, s);
  }

  // Wait for recovery and election
  await sleep(800);

  client = new KVClient(servers, {
    sendHandler: async (idx, op) => {
      const s = servers[idx];
      if (!s || s.isKilled) throw new Error('Node down');
      if (op.type === 'GET') return await s.get(op.key, op.clientId, op.seq);
      if (op.type === 'PUT') return await s.put(op.key, op.value, op.clientId, op.seq);
      if (op.type === 'APPEND') return await s.append(op.key, op.value, op.clientId, op.seq);
    }
  });

  // 4. Verify all previously committed data survived the crash
  console.log('Step 5: Verifying data durability and continuing operations...');
  const val1 = await client.get('service_status');
  const val2 = await client.get('db_version');
  const val3 = await client.get('audit_log');

  assert.strictEqual(val1, 'PRODUCTION_ACTIVE', 'service_status must survive crash');
  assert.strictEqual(val2, 'v2.4.1', 'db_version must survive crash');
  assert.strictEqual(val3, 'event:login;event:payment;', 'audit_log must survive crash');
  console.log('  ✓ All committed keys and values survived total cluster reboot without loss!');

  // 5. Append new data after recovery to ensure cluster continues operating normally
  await client.append('audit_log', 'event:recovery_complete;');
  const val4 = await client.get('audit_log');
  assert.strictEqual(val4, 'event:login;event:payment;event:recovery_complete;');
  console.log('  ✓ Post-recovery operations succeeded smoothly');

  servers.forEach(s => s.kill());

  // Clean test directory
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log('✓ Disk Persistence & Crash Recovery Tests Passed!\n');
}

if (process.argv[1].endsWith('test_persistence.js')) {
  runPersistenceTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
