import assert from 'node:assert';
import { RaftNode } from '../src/raft/raft.js';
import { Persister } from '../src/raft/persister.js';
import { NetworkSimulator } from '../src/net/network_simulator.js';
import { sleep } from '../src/common/utils.js';
import { NodeState } from '../src/common/types.js';

export async function runElectionTests() {
  console.log('\n--- Running Raft Election Tests (MIT 6.824 Lab 2A) ---');

  // Test 1: Initial Election
  {
    console.log('Test 1: Initial Leader Election (3 nodes)...');
    const net = new NetworkSimulator();
    const persisters = [new Persister(0), new Persister(1), new Persister(2)];
    const nodes = [];
    const peers = [0, 1, 2];

    for (let i = 0; i < 3; i++) {
      const node = new RaftNode(i, peers, persisters[i], () => {}, {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: 50
      });
      nodes.push(node);
      net.registerNode(i, { raft: node, isKilled: false });
    }

    // Wait for election
    await sleep(600);

    const leaders = nodes.filter(n => n.state === NodeState.LEADER);
    assert.strictEqual(leaders.length, 1, `Expected exactly 1 leader, found ${leaders.length}`);
    const leader = leaders[0];
    const initialTerm = leader.currentTerm;
    assert.ok(initialTerm >= 1, `Expected term >= 1, got ${initialTerm}`);
    console.log(`  ✓ Leader elected: Node ${leader.nodeId} in Term ${initialTerm}`);

    // Verify term remains stable with no failures
    await sleep(400);
    assert.strictEqual(leader.state, NodeState.LEADER, 'Leader should remain stable');
    assert.strictEqual(leader.currentTerm, initialTerm, 'Term should remain stable');
    console.log('  ✓ Leader stayed stable across heartbeats');

    // Clean up
    nodes.forEach(n => n.kill());
  }

  // Test 2: Re-election upon Leader Crash
  {
    console.log('Test 2: Re-election upon Leader Failure...');
    const net = new NetworkSimulator();
    const persisters = [new Persister(0), new Persister(1), new Persister(2)];
    const nodes = [];
    const peers = [0, 1, 2];

    for (let i = 0; i < 3; i++) {
      const node = new RaftNode(i, peers, persisters[i], () => {}, {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: 50
      });
      nodes.push(node);
      net.registerNode(i, { raft: node, isKilled: false });
    }

    await sleep(600);
    const oldLeader = nodes.find(n => n.state === NodeState.LEADER);
    assert.ok(oldLeader, 'Should have an initial leader');
    console.log(`  Crashing current leader: Node ${oldLeader.nodeId}`);

    oldLeader.kill();
    net.disconnect(oldLeader.nodeId);

    // Wait for followers to detect leader absence and elect new leader
    await sleep(800);

    const aliveNodes = nodes.filter(n => n.nodeId !== oldLeader.nodeId);
    const newLeaders = aliveNodes.filter(n => n.state === NodeState.LEADER);
    assert.strictEqual(newLeaders.length, 1, `Expected 1 new leader from surviving nodes, found ${newLeaders.length}`);
    const newLeader = newLeaders[0];
    assert.ok(newLeader.currentTerm > oldLeader.currentTerm, 'New leader should be in higher term');
    console.log(`  ✓ New leader elected: Node ${newLeader.nodeId} in Term ${newLeader.currentTerm}`);

    nodes.forEach(n => n.kill());
  }

  console.log('✓ Raft Election Tests Passed!\n');
}

if (process.argv[1].endsWith('test_election.js')) {
  runElectionTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
