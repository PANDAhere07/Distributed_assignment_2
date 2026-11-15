import assert from 'node:assert';
import { KVServer } from '../src/kv/server.js';
import { KVClient } from '../src/kv/client.js';
import { Persister } from '../src/raft/persister.js';
import { NetworkSimulator } from '../src/net/network_simulator.js';
import { sleep } from '../src/common/utils.js';

export async function runSnapshotTests() {
  console.log('\n--- Running Log Compaction & InstallSnapshot Tests (MIT 6.824 Lab 2D / 3B) ---');

  const net = new NetworkSimulator();
  const peers = [0, 1, 2];
  const persisters = peers.map(id => new Persister(id));
  const servers = [];

  // Low maxRaftState to trigger aggressive snapshotting
  for (let i = 0; i < 3; i++) {
    const s = new KVServer(i, peers, persisters[i], {
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50,
      maxRaftState: 300 // Snapshot when state exceeds 300 bytes
    });
    servers.push(s);
    net.registerNode(i, s);
  }

  await sleep(650);

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

  // 1. Verify log compaction
  console.log('Test 1: Log Compaction on Growing State...');
  for (let i = 0; i < 15; i++) {
    await client.put(`key_${i}`, `value_data_chunk_${i}_timestamp_${Date.now()}`);
  }

  await sleep(500);

  const leaderId = client.knownLeader;
  const leader = servers[leaderId];
  const firstIndex = leader.raft.log.getFirstLogIndex();
  console.log(`  Leader firstLogIndex after compaction: ${firstIndex}`);
  assert.ok(firstIndex > 0, `Log compaction should advance firstLogIndex beyond 0, got ${firstIndex}`);
  console.log('  ✓ Log successfully compacted into snapshot, bound memory consumption');

  // 2. Disconnect a follower, write many entries to advance log past follower's nextIndex,
  // then reconnect and verify InstallSnapshot catchup!
  console.log('Test 2: InstallSnapshot Catchup for Lagging Follower...');
  const followerId = (leaderId + 1) % 3;
  const follower = servers[followerId];

  console.log(`  Disconnecting Follower Node ${followerId}...`);
  net.disconnect(followerId);

  // Write 15 more entries so leader discards log entries beyond follower's last applied
  for (let i = 15; i < 30; i++) {
    await client.put(`key_${i}`, `snapshot_test_val_${i}`);
  }

  const leaderCompactedIndex = leader.raft.log.getFirstLogIndex();
  console.log(`  Leader has now compacted up to index: ${leaderCompactedIndex}`);
  console.log(`  Follower Node ${followerId} lastApplied index is: ${follower.raft.lastApplied}`);
  assert.ok(
    leaderCompactedIndex > follower.raft.lastApplied,
    'Leader compacted index must exceed follower last applied index to force InstallSnapshot'
  );

  console.log(`  Reconnecting Follower Node ${followerId} (forcing InstallSnapshot RPC)...`);
  net.connect(followerId);

  // Allow InstallSnapshot to transmit and apply
  await sleep(800);

  // Verify follower caught up
  console.log(`  Follower Node ${followerId} lastApplied after catchup: ${follower.raft.lastApplied}`);
  assert.strictEqual(
    follower.kvStore.size,
    30,
    `Follower should have all 30 keys in its state machine, found ${follower.kvStore.size}`
  );

  // Verify linearizable read directly from the caught-up follower's KV store
  for (let i = 0; i < 30; i++) {
    const val = follower.kvStore.get(`key_${i}`);
    assert.ok(val, `Follower must have key_${i}`);
  }
  console.log('  ✓ Follower successfully received InstallSnapshot, restored state machine, and caught up!');

  servers.forEach(s => s.kill());
  console.log('✓ Log Compaction & InstallSnapshot Tests Passed!\n');
}

if (process.argv[1].endsWith('test_snapshots.js')) {
  runSnapshotTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
