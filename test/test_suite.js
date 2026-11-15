import { runElectionTests } from './test_election.js';
import { runReplicationTests } from './test_replication.js';
import { runPartitionTests } from './test_partition.js';
import { runKVConsistencyTests } from './test_kv_consistency.js';
import { runSnapshotTests } from './test_snapshots.js';
import { runPersistenceTests } from './test_persistence.js';

async function main() {
  console.log('========================================================================');
  console.log('      DISTRIKV - MIT 6.824 / 6.5840 COMPREHENSIVE TEST SUITE');
  console.log('      Distributed Systems: Fault Tolerance, Replication, & Consistency');
  console.log('========================================================================\n');

  const suiteStart = Date.now();
  const results = [];

  const testModules = [
    { name: '1. Leader Election & Heartbeats (Lab 2A)', fn: runElectionTests },
    { name: '2. Log Replication & Quorum Agreement (Lab 2B)', fn: runReplicationTests },
    { name: '3. Network Partitions & Split-Brain Prevention (Lab 2B/2C)', fn: runPartitionTests },
    { name: '4. Key-Value Linearizability & Deduplication (Lab 3A)', fn: runKVConsistencyTests },
    { name: '5. Log Compaction & InstallSnapshot (Lab 2D/3B)', fn: runSnapshotTests },
    { name: '6. Durable Persistence & Catastrophic Crash Recovery (Lab 2C)', fn: runPersistenceTests }
  ];

  for (const t of testModules) {
    const tStart = Date.now();
    try {
      await t.fn();
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(2);
      results.push({ module: t.name, status: 'PASSED', time: `${elapsed}s` });
    } catch (err) {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(2);
      results.push({ module: t.name, status: 'FAILED', time: `${elapsed}s`, error: err.message });
      console.error(`\n❌ ${t.name} failed with error:`, err);
    }
  }

  const totalElapsed = ((Date.now() - suiteStart) / 1000).toFixed(2);

  console.log('\n========================================================================');
  console.log('                         TEST RESULTS SUMMARY');
  console.log('========================================================================');
  console.table(results);

  const passed = results.filter(r => r.status === 'PASSED').length;
  console.log(`\nResults: ${passed}/${results.length} Test Suites Passed in ${totalElapsed}s`);

  if (passed === results.length) {
    console.log('🎉 ALL DISTRIBUTED SYSTEMS SAFETY & LIVENESS INVARIANTS SATISFIED!');
    process.exit(0);
  } else {
    console.error('⚠️ SOME TESTS FAILED. PLEASE REVIEW LOGS ABOVE.');
    process.exit(1);
  }
}

main();
