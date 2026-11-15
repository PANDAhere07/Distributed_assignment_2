import assert from 'node:assert';
import { RaftNode } from '../src/raft/raft.js';
import { Persister } from '../src/raft/persister.js';
import { NetworkSimulator } from '../src/net/network_simulator.js';
import { sleep } from '../src/common/utils.js';
import { NodeState } from '../src/common/types.js';

export async function runPartitionTests() {
  console.log('\n--- Running Network Partition & Split-Brain Prevention Tests (MIT 6.824 Lab 2B/2C) ---');

  const net = new NetworkSimulator();
  const peers = [0, 1, 2, 3, 4];
  const persisters = peers.map(id => new Persister(id));
  const nodes = [];
  const appliedCommands = [[], [], [], [], []];

  for (let i = 0; i < 5; i++) {
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

  // 1. Initial election
  console.log('Step 1: Electing initial leader for 5-node cluster...');
  await sleep(650);
  let leader1 = nodes.find(n => n.state === NodeState.LEADER);
  assert.ok(leader1, 'Initial leader must be elected');
  console.log(`  ✓ Initial Leader is Node ${leader1.nodeId} (Term ${leader1.currentTerm})`);

  // Propose initial agreed command
  leader1.start('cmd-genesis');
  await sleep(400);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(appliedCommands[i].length, 1, `Node ${i} should have applied genesis`);
  }
  console.log('  ✓ Genesis command committed across all 5 nodes');

  // 2. Partition: Put leader in minority group of 2, other 3 in majority group
  const leaderId = leader1.nodeId;
  const otherIds = peers.filter(id => id !== leaderId);
  const minority = [leaderId, otherIds[0]];
  const majority = otherIds.slice(1); // 3 nodes

  console.log(`Step 2: Partitioning cluster into Minority {${minority.join(',')}} and Majority {${majority.join(',')}}...`);
  net.setPartition([minority, majority]);

  // 3. Propose command to minority leader
  console.log('Step 3: Proposing command to minority partition leader...');
  const minorityRes = leader1.start('cmd-minority-proposal');
  assert.ok(minorityRes.isLeader, 'Old leader still thinks it is leader');

  // Wait to allow potential (invalid) replication
  await sleep(600);

  // Assert that minority CANNOT commit because quorum is 3 out of 5!
  for (const id of minority) {
    const hasCommitted = appliedCommands[id].some(m => m.command === 'cmd-minority-proposal');
    assert.strictEqual(hasCommitted, false, `Node ${id} in minority partition must NOT commit without quorum!`);
  }
  console.log('  ✓ Verified: Minority partition was unable to commit (Safety Invariant preserved)');

  // 4. Majority partition elects new leader and commits
  console.log('Step 4: Verifying majority partition elects new leader and commits...');
  const majorityNodes = nodes.filter(n => majority.includes(n.nodeId));
  let leader2 = null;
  for (let wait = 0; wait < 15; wait++) {
    leader2 = majorityNodes.find(n => n.state === NodeState.LEADER);
    if (leader2) break;
    await sleep(100);
  }
  assert.ok(leader2, 'Majority partition must elect a new leader');
  console.log(`  ✓ Majority elected new Leader: Node ${leader2.nodeId} (Term ${leader2.currentTerm})`);

  // Propose command in majority partition
  leader2.start('cmd-majority-committed');
  await sleep(500);

  for (const id of majority) {
    const hasCommitted = appliedCommands[id].some(m => m.command === 'cmd-majority-committed');
    assert.strictEqual(hasCommitted, true, `Majority Node ${id} must commit command`);
  }
  console.log('  ✓ Majority successfully committed command with quorum (3/5)');

  // 5. Heal partition
  console.log('Step 5: Healing network partition (reunifying all 5 nodes)...');
  net.healPartition();
  await sleep(700);

  // Propose final command to unified cluster
  const currentLeader = nodes.find(n => n.state === NodeState.LEADER);
  assert.ok(currentLeader, 'Unified cluster must have a leader');
  currentLeader.start('cmd-unified-all');
  await sleep(700);

  // All 5 nodes must now have applied genesis, cmd-majority-committed, and cmd-unified-all!
  // And cmd-minority-proposal must NOT be present anywhere because it was never committed!
  for (let i = 0; i < 5; i++) {
    const applied = appliedCommands[i];
    const cmds = applied.map(m => m.command);
    assert.ok(cmds.includes('cmd-genesis'), `Node ${i} must have genesis`);
    assert.ok(cmds.includes('cmd-majority-committed'), `Node ${i} must have majority command`);
    assert.ok(cmds.includes('cmd-unified-all'), `Node ${i} must have unified command`);
    assert.strictEqual(
      cmds.includes('cmd-minority-proposal'),
      false,
      `Node ${i} must NEVER commit uncommitted minority proposal`
    );
  }

  console.log('  ✓ All 5 nodes unified: uncommitted minority entries safely overwritten, zero split-brain!');
  nodes.forEach(n => n.kill());
  console.log('✓ Network Partition & Split-Brain Prevention Tests Passed!\n');
}

if (process.argv[1].endsWith('test_partition.js')) {
  runPartitionTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
