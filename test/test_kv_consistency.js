import assert from 'node:assert';
import { KVServer } from '../src/kv/server.js';
import { KVClient } from '../src/kv/client.js';
import { Persister } from '../src/raft/persister.js';
import { NetworkSimulator } from '../src/net/network_simulator.js';
import { sleep } from '../src/common/utils.js';

export async function runKVConsistencyTests() {
  console.log('\n--- Running KV Store Consistency & Linearizability Tests (MIT 6.824 Lab 3A) ---');

  const net = new NetworkSimulator();
  const peers = [0, 1, 2];
  const persisters = peers.map(id => new Persister(id));
  const servers = [];

  for (let i = 0; i < 3; i++) {
    const s = new KVServer(i, peers, persisters[i], {
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50
    });
    servers.push(s);
    net.registerNode(i, s);
  }

  // Allow leader election
  await sleep(650);

  // Client connected to servers
  const client = new KVClient(servers, {
    sendHandler: async (serverIndex, op) => {
      const s = servers[serverIndex];
      if (!s || s.isKilled) throw new Error('Node down');
      if (op.type === 'GET') {
        return await s.get(op.key, op.clientId, op.seq);
      } else if (op.type === 'PUT') {
        return await s.put(op.key, op.value, op.clientId, op.seq);
      } else if (op.type === 'APPEND') {
        return await s.append(op.key, op.value, op.clientId, op.seq);
      }
    }
  });

  // 1. Basic Sequential Put, Append, Get
  console.log('Test 1: Sequential Linearizable Put, Append, Get...');
  await client.put('course', 'MIT 6.824');
  let val = await client.get('course');
  assert.strictEqual(val, 'MIT 6.824', 'Get should return put value');

  await client.append('course', ' Distributed Systems');
  val = await client.get('course');
  assert.strictEqual(val, 'MIT 6.824 Distributed Systems', 'Get should return appended value');
  console.log('  ✓ Put, Append, Get linearizability verified');

  // 2. Duplicate RPC Suppression
  console.log('Test 2: Duplicate RPC Suppression (At-Most-Once / Exactly-Once Semantics)...');
  const leaderId = client.knownLeader;
  const leaderServer = servers[leaderId];

  // Send request with explicit seq = 100
  const clientId = 'test-client-dup';
  const firstRes = await leaderServer.append('account', '50', clientId, 100);
  assert.strictEqual(firstRes.err, 'OK');
  assert.strictEqual(firstRes.value, '50');

  // Retransmit same RPC with identical seq = 100 (simulating network duplicate)
  const dupRes = await leaderServer.append('account', '50', clientId, 100);
  assert.strictEqual(dupRes.err, 'OK');
  assert.strictEqual(dupRes.value, '50', 'Duplicate append must NOT increment value again!');

  val = await client.get('account');
  assert.strictEqual(val, '50', 'Account balance should remain 50, duplicate append was ignored');
  console.log('  ✓ Duplicate RPC successfully deduplicated, exactly-once execution guaranteed');

  // 3. Concurrent Clients & Lost Update Prevention
  console.log('Test 3: Concurrent Multi-Client Appends (Race Condition & Lost Update Prevention)...');
  const c1 = new KVClient(servers, { sendHandler: client.sendHandler });
  const c2 = new KVClient(servers, { sendHandler: client.sendHandler });
  const c3 = new KVClient(servers, { sendHandler: client.sendHandler });

  await client.put('shared_list', '');

  const runClient = async (cli, prefix, count) => {
    for (let i = 0; i < count; i++) {
      await cli.append('shared_list', `${prefix}${i},`);
    }
  };

  // Launch 3 clients concurrently
  await Promise.all([
    runClient(c1, 'A', 5),
    runClient(c2, 'B', 5),
    runClient(c3, 'C', 5)
  ]);

  const finalVal = await client.get('shared_list');
  console.log(`  Combined string length: ${finalVal.length}`);

  // Check that all 15 entries are present
  for (let i = 0; i < 5; i++) {
    assert.ok(finalVal.includes(`A${i},`), `Missing A${i}`);
    assert.ok(finalVal.includes(`B${i},`), `Missing B${i}`);
    assert.ok(finalVal.includes(`C${i},`), `Missing C${i}`);
  }

  // Check state consistency across all 3 servers
  for (const s of servers) {
    const sVal = s.kvStore.get('shared_list');
    assert.strictEqual(sVal, finalVal, `Server ${s.nodeId} state must match linearizable history`);
  }
  console.log('  ✓ All 15 concurrent updates safely serialized with zero lost updates');

  servers.forEach(s => s.kill());
  console.log('✓ KV Store Consistency Tests Passed!\n');
}

if (process.argv[1].endsWith('test_kv_consistency.js')) {
  runKVConsistencyTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
