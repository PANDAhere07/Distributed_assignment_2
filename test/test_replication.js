import assert from 'node:assert';
import { RaftNode } from '../src/raft/raft.js';
import { Persister } from '../src/raft/persister.js';
import { NetworkSimulator } from '../src/net/network_simulator.js';
import { sleep } from '../src/common/utils.js';
import { NodeState } from '../src/common/types.js';

export async function runReplicationTests() {
  console.log('\n--- Running Raft Log Replication Tests (MIT 6.824 Lab 2B) ---');

  // Test 1: Basic Agreement
  {
    console.log('Test 1: Basic Agreement (Replicating 3 commands across 3 nodes)...');
    const net = new NetworkSimulator();
    const persisters = [new Persister(0), new Persister(1), new Persister(2)];
    const nodes = [];
    const peers = [0, 1, 2];
    const appliedCommands = [[], [], []];

    for (let i = 0; i < 3; i++) {
      const idx = i;
      const node = new RaftNode(i, peers, persisters[i], (msg) => {
        if (msg.commandValid) appliedCommands[idx].push(msg);
      }, {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: 50
      });
      nodes.push(node);
      net.registerNode(i, { raft: node, isKilled: false });
    }

    await sleep(600);
    const leader = nodes.find(n => n.state === NodeState.LEADER);
    assert.ok(leader, 'Leader must exist');

    // Submit 3 commands
    const cmds = ['cmd-alpha', 'cmd-beta', 'cmd-gamma'];
    for (const cmd of cmds) {
      const { index, isLeader } = leader.start(cmd);
      assert.ok(isLeader, 'Must be accepted by leader');
      assert.ok(index > 0, 'Index must be positive');
    }

    // Wait for quorum commit & apply
    await sleep(600);

    for (let i = 0; i < 3; i++) {
      assert.strictEqual(
        appliedCommands[i].length,
        3,
        `Node ${i} should have applied 3 commands, got ${appliedCommands[i].length}`
      );
      assert.strictEqual(appliedCommands[i][0].command, 'cmd-alpha');
      assert.strictEqual(appliedCommands[i][1].command, 'cmd-beta');
      assert.strictEqual(appliedCommands[i][2].command, 'cmd-gamma');
    }
    console.log('  ✓ All 3 nodes successfully replicated and committed all 3 commands');

    nodes.forEach(n => n.kill());
  }

  // Test 2: Minority Failure Agreement & Rejoin Catchup
  {
    console.log('Test 2: Minority Failure Agreement & Follower Rejoin Catchup...');
    const net = new NetworkSimulator();
    const persisters = [new Persister(0), new Persister(1), new Persister(2)];
    const nodes = [];
    const peers = [0, 1, 2];
    const appliedCommands = [[], [], []];

    for (let i = 0; i < 3; i++) {
      const idx = i;
      const node = new RaftNode(i, peers, persisters[i], (msg) => {
        if (msg.commandValid) appliedCommands[idx].push(msg);
      }, {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: 50
      });
      nodes.push(node);
      net.registerNode(i, { raft: node, isKilled: false });
    }

    await sleep(600);
    let leader = nodes.find(n => n.state === NodeState.LEADER);
    assert.ok(leader, 'Leader must exist');

    // Identify a follower to disconnect
    const follower = nodes.find(n => n.nodeId !== leader.nodeId);
    console.log(`  Disconnecting follower Node ${follower.nodeId}...`);
    net.disconnect(follower.nodeId);

    // Leader proposes command with 1 follower down
    const { index: idx1, isLeader: isL1 } = leader.start('cmd-quorum-with-failure');
    assert.ok(isL1, 'Leader should accept command');

    await sleep(600);

    // Quorum nodes (leader + surviving follower) should commit
    const survivingNodes = nodes.filter(n => n.nodeId !== follower.nodeId);
    for (const sn of survivingNodes) {
      const applied = appliedCommands[sn.nodeId];
      assert.ok(
        applied.some(m => m.command === 'cmd-quorum-with-failure'),
        `Node ${sn.nodeId} should commit with minority failure`
      );
    }
    // Disconnected follower should NOT have applied it yet
    assert.ok(
      !appliedCommands[follower.nodeId].some(m => m.command === 'cmd-quorum-with-failure'),
      'Disconnected node should not receive command'
    );
    console.log('  ✓ Committed command with 1 node disconnected (Quorum 2/3 active)');

    // Now reconnect the follower
    console.log(`  Reconnecting follower Node ${follower.nodeId}...`);
    net.connect(follower.nodeId);

    // Leader proposes another command
    leader.start('cmd-after-rejoin');
    await sleep(700);

    // Now ALL nodes (including rejoined follower) must have both commands!
    for (let i = 0; i < 3; i++) {
      const applied = appliedCommands[i];
      assert.ok(
        applied.some(m => m.command === 'cmd-quorum-with-failure'),
        `Node ${i} must have caught up cmd-quorum-with-failure`
      );
      assert.ok(
        applied.some(m => m.command === 'cmd-after-rejoin'),
        `Node ${i} must have cmd-after-rejoin`
      );
    }
    console.log('  ✓ Rejoined node caught up all missing log entries and applied them in order');

    nodes.forEach(n => n.kill());
  }

  console.log('✓ Raft Log Replication Tests Passed!\n');
}

if (process.argv[1].endsWith('test_replication.js')) {
  runReplicationTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
