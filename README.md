# DistriKV: Fault-Tolerant Replicated Distributed Key-Value Service

[![MIT 6.824 / 6.5840](https://img.shields.io/badge/Course-MIT%206.824%20%2F%206.5840-A31F34?style=flat&logo=mit)](https://pdos.csail.mit.edu/6.824/)
[![Consensus](https://img.shields.io/badge/Consensus-Raft-blue.svg)](https://raft.github.io/)
[![Consistency](https://img.shields.io/badge/Consistency-Linearizable%20(Strong)-green.svg)]()
[![Tests](https://img.shields.io/badge/Tests-6%2F6%20Passed-brightgreen.svg)]()
[![Runtime](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js)](https://nodejs.org/)

An enterprise-grade, zero-dependency distributed key-value service implementing **Fault Tolerance**, **State Machine Replication (SMR)**, and **Linearizable Consistency** powered by the **Raft Consensus Algorithm** (Ongaro & Ousterhout, Stanford University), directly aligned with **MIT 6.824 / 6.5840 Distributed Systems** specifications.

---

## Table of Contents
1. [Core Features & Invariants](#core-features--invariants)
2. [Distributed Systems Architecture](#distributed-systems-architecture)
   - [Consensus Engine (Raft)](#1-consensus-engine-raft)
   - [Key-Value State Machine](#2-key-value-state-machine)
   - [Linearizability & Exactly-Once Semantics](#3-linearizability--exactly-once-semantics)
   - [Log Compaction & Snapshots](#4-log-compaction--snapshots)
   - [Durable Disk Persistence](#5-durable-disk-persistence)
3. [Project Structure](#project-structure)
4. [Execution Instructions](#execution-instructions)
   - [Prerequisites](#prerequisites)
   - [Running the Interactive Web Visualizer](#running-the-interactive-web-visualizer)
   - [Running the Interactive CLI Shell](#running-the-interactive-cli-shell)
   - [Running Automated Test Suites](#running-automated-test-suites)
5. [Testing Results & Invariant Verification](#testing-results--invariant-verification)
6. [Interactive Dashboard & Screenshot Previews](#interactive-dashboard--screenshot-previews)
7. [MIT 6.824 Reference Mapping](#mit-6824-reference-mapping)

---

## Core Features & Invariants

| Distributed Principle | Implementation Mechanism | Invariant Guaranteed |
| :--- | :--- | :--- |
| **Fault Tolerance** | Randomized election timers, automatic failover, Pre-Vote protocol | Survives crash or partition of up to $\lfloor(N-1)/2\rfloor$ nodes. Normal progress continues seamlessly as long as a strict majority ($\ge \lfloor N/2 \rfloor + 1$) is alive. |
| **Replication** | State Machine Replication (SMR) via Raft Log Replication | **Log Matching Property**: If two entries in different logs have the same index and term, they store the same command and their logs are identical up to that index. |
| **Consistency** | Linearizability (Strong Consistency) with client request deduplication | Sequential ordering of all reads (`GET`) and writes (`PUT`, `APPEND`). All reads return the latest committed write. Retransmissions receive cached responses without re-executing. |
| **Split-Brain Prevention** | Quorum commitment rule ($Q = \lfloor N/2 \rfloor + 1$) | Minority partitions cannot commit entries. Two leaders can never be elected for the same term. Conflicting uncommitted entries are safely overwritten upon partition heal. |
| **Log Compaction** | In-memory & disk snapshotting (`InstallSnapshot` RPC) | Discards committed log entries exceeding size thresholds, bounding memory usage. Slow or recovering followers catch up via snapshot streams. |
| **Persistence** | Durable WAL disk serialization (`Persister`) | `currentTerm`, `votedFor`, `log`, and `snapshot` survive power failures or total cluster reboot without data loss. |

---

## Distributed Systems Architecture

```
                       +-----------------------------------+
                       |         Distributed Client        |
                       | (Smart retry, leader redirection) |
                       +-----------------+-----------------+
                                         |
                                         | Client Operations (PUT, APPEND, GET)
                                         v
       +---------------------------------+---------------------------------+
       |                                 |                                 |
+------v------+                   +------v------+                   +------v------+
| Node 0      |                   | Node 1      |                   | Node 2      |
| [FOLLOWER]  |                   | [LEADER]    |                   | [FOLLOWER]  |
|             |                   |             |                   |             |
| +---------+ |   AppendEntries   | +---------+ |   AppendEntries   | +---------+ |
| | KVStore | | <---------------- | | KVStore | | ----------------> | | KVStore | |
| +----+----+ |                   | +----+----+ |                   | +----+----+ |
|      |      |                   |      |      |                   |      |      |
| +----+----+ |    Heartbeats     | +----+----+ |    Heartbeats     | +----+----+ |
| |  Raft   | | <---------------- | |  Raft   | | ----------------> | |  Raft   | |
| | Engine  | |                   | | Engine  | |                   | | Engine  | |
| +----+----+ |                   | +----+----+ |                   | +----+----+ |
|      |      |                   |      |      |                   |      |      |
| +----+----+ |                   | +----+----+ |                   | +----+----+ |
| | Disk WAL| |                   | | Disk WAL| |                   | | Disk WAL| |
| +---------+ |                   | +---------+ |                   | +---------+ |
+-------------+                   +-------------+                   +-------------+
```

### 1. Consensus Engine (Raft)
- **Role FSM**: Nodes transition between `FOLLOWER`, `CANDIDATE`, and `LEADER`.
- **Pre-Vote Protocol (Sec 9.6)**: Disconnected nodes run a speculative Pre-Vote round before bumping terms, preventing disrupted partitioned followers from deposing active leaders upon reconnection.
- **Election Restriction (Sec 5.4.1)**: Voters reject candidate votes unless candidate's log is at least as up-to-date as the voter's log:
  $$\text{candidateLogOk} = (T_{\text{candidate}} > T_{\text{voter}}) \lor (T_{\text{candidate}} == T_{\text{voter}} \land I_{\text{candidate}} \ge I_{\text{voter}})$$
- **Quorum Commitment (Sec 5.4.2)**: A leader commits log entry $N$ if stored on a majority of nodes and $T_N = T_{\text{current}}$.

### 2. Key-Value State Machine
- Provides three state machine operations:
  - `PUT(key, value)`: Sets $K \leftarrow V$.
  - `APPEND(key, value)`: Sets $K \leftarrow K + V$ (atomic string concatenation).
  - `GET(key)`: Returns current value for key $K$.
- Operations are applied strictly in committed log order through the decoupled apply pipeline (`applyCh`).

### 3. Linearizability & Exactly-Once Semantics
- Each client maintains a unique `clientId` and monotonically increasing sequence number `seq`.
- The KV server maintains a deduplication table: `clientAcks: Map<clientId, { seq, value }>`.
- When network packets are duplicated or retransmitted after a leader election, the server identifies `seq <= lastAck.seq` and immediately returns the cached result without reapplying mutations.

### 4. Log Compaction & Snapshots
- When persistent log size exceeds `maxRaftState`, the KV server generates a snapshot of its state machine dictionary and deduplication records.
- Raft compacts log entries up to `lastIncludedIndex` and stores `lastIncludedTerm`.
- If a follower lags behind the leader's compacted log prefix (`nextIndex[p] <= firstLogIndex`), the leader sends an `InstallSnapshot` RPC, allowing the lagging follower to catch up instantly.

### 5. Durable Disk Persistence
- Persister writes state to `data/raft-state-{id}.json` and `data/snapshot-{id}.json`.
- State survives sudden crashes and total cluster power-loss without diverging.

---

## Project Structure

```
Distributed_Assignment_2/
├── package.json               # Project manifest, dependencies, npm test scripts
├── README.md                  # Complete architectural documentation & report
├── src/
│   ├── common/
│   │   ├── types.js           # Enums (NodeState, RPCType, OpType, ErrorCode)
│   │   └── utils.js           # Timing, randomized backoff, deepClone, Logger
│   ├── raft/
│   │   ├── raft.js            # Core Raft consensus engine (Election, SMR, Commit)
│   │   ├── log.js             # RaftLog array with snapshot offset indexing
│   │   └── persister.js       # Disk WAL persistence & snapshot serializer
│   ├── kv/
│   │   ├── server.js          # Replicated KV State Machine & client deduplication
│   │   └── client.js          # Linearizable client with automatic leader tracking
│   ├── net/
│   │   ├── network_simulator.js # In-memory network simulator (partitions, packet drops)
│   │   └── rpc.js             # HTTP/REST networking server for standalone nodes
│   ├── dashboard/
│   │   ├── server.js          # HTTP cluster manager & dashboard backend
│   │   └── public/
│   │       ├── index.html     # Real-time web visualizer interface
│   │       ├── style.css      # Dark-mode dashboard styling
│   │       └── app.js         # Interactive client console & live RPC visualizer
│   └── cli.js                 # Terminal CLI for interactive command execution
├── test/
│   ├── test_suite.js          # Master test runner (executes all 6 suites)
│   ├── test_election.js       # Lab 2A: Leader election & term stability
│   ├── test_replication.js    # Lab 2B: Log replication & minority failure agreement
│   ├── test_partition.js      # Lab 2B/2C: Network partitions & split-brain prevention
│   ├── test_kv_consistency.js # Lab 3A: Linearizability, deduplication, concurrency
│   ├── test_snapshots.js      # Lab 2D/3B: Log compaction & InstallSnapshot
│   └── test_persistence.js    # Lab 2C: Disk persistence & full crash recovery
└── data/                      # Persistent storage directory for node WAL files
```

---

## Execution Instructions

### Prerequisites
- Node.js version 18.0.0 or higher (`node -v`)
- npm package manager (`npm -v`)
- Any modern web browser (Chrome, Edge, Firefox, Safari)

### Running the Interactive Web Visualizer
1. Start the cluster manager and web server:
   ```bash
   npm start
   ```
2. Open your web browser and navigate to:
   ```
   http://localhost:8080
   ```
3. From the dashboard:
   - View real-time cluster status, node roles, terms, commit indices, and live logs.
   - Use **Fault Injection buttons**:
     - **Isolate Leader**: Cut the leader into a minority partition and observe automatic re-election in the majority.
     - **Split Partition (2 vs 3)**: Verify minority cannot commit without quorum ($3/5$).
     - **Heal Partitions**: Watch uncommitted minority entries overwrite cleanly as the cluster unifies.
     - **Run Chaos Monkey**: Execute 15 concurrent operations while randomly crashing and restarting nodes.
   - Use the **Interactive Client Console**:
     - Submit `PUT`, `APPEND`, and `GET` requests with instant latency and leader telemetry.

### Running the Interactive CLI Shell
In a separate terminal, interact with the cluster via the command line:
```bash
# Start interactive shell:
npm run cli

# Or execute one-off commands:
node src/cli.js put user_name "Alice"
node src/cli.js append user_name " Smith"
node src/cli.js get user_name
node src/cli.js status
```

### Running Automated Test Suites
Execute the full comprehensive test suite:
```bash
npm test
```

Or run individual targeted test modules:
```bash
npm run test:election      # Lab 2A: Leader Election
npm run test:replication   # Lab 2B: Log Replication & Fault Tolerance
npm run test:partition     # Lab 2B/2C: Network Partitions & Split-Brain
npm run test:kv            # Lab 3A: KV Linearizability & Deduplication
npm run test:snapshot      # Lab 2D/3B: Log Compaction & InstallSnapshot
npm run test:persist       # Lab 2C: Disk Persistence & Crash Recovery
```

---

## Testing Results & Invariant Verification

All test suites executed against the distributed service and achieved **100% pass rate**:

```
========================================================================
      DISTRIKV - MIT 6.824 / 6.5840 COMPREHENSIVE TEST SUITE
      Distributed Systems: Fault Tolerance, Replication, & Consistency
========================================================================

--- Running Raft Election Tests (MIT 6.824 Lab 2A) ---
Test 1: Initial Leader Election (3 nodes)...
  ✓ Leader elected: Node 0 in Term 2
  ✓ Leader stayed stable across heartbeats
Test 2: Re-election upon Leader Failure...
  Crashing current leader: Node 1
  ✓ New leader elected: Node 2 in Term 3
✓ Raft Election Tests Passed!

--- Running Raft Log Replication Tests (MIT 6.824 Lab 2B) ---
Test 1: Basic Agreement (Replicating 3 commands across 3 nodes)...
  ✓ All 3 nodes successfully replicated and committed all 3 commands
Test 2: Minority Failure Agreement & Follower Rejoin Catchup...
  Disconnecting follower Node 0...
  ✓ Committed command with 1 node disconnected (Quorum 2/3 active)
  Reconnecting follower Node 0...
  ✓ Rejoined node caught up all missing log entries and applied them in order
✓ Raft Log Replication Tests Passed!

--- Running Network Partition & Split-Brain Prevention Tests (MIT 6.824 Lab 2B/2C) ---
Step 1: Electing initial leader for 5-node cluster...
  ✓ Initial Leader is Node 0 (Term 3)
  ✓ Genesis command committed across all 5 nodes
Step 2: Partitioning cluster into Minority {0,1} and Majority {2,3,4}...
Step 3: Proposing command to minority partition leader...
  ✓ Verified: Minority partition was unable to commit (Safety Invariant preserved)
Step 4: Verifying majority partition elects new leader and commits...
  ✓ Majority elected new Leader: Node 3 (Term 4)
  ✓ Majority successfully committed command with quorum (3/5)
Step 5: Healing network partition (reunifying all 5 nodes)...
  ✓ All 5 nodes unified: uncommitted minority entries safely overwritten, zero split-brain!
✓ Network Partition & Split-Brain Prevention Tests Passed!

--- Running KV Store Consistency & Linearizability Tests (MIT 6.824 Lab 3A) ---
Test 1: Sequential Linearizable Put, Append, Get...
  ✓ Put, Append, Get linearizability verified
Test 2: Duplicate RPC Suppression (At-Most-Once / Exactly-Once Semantics)...
  ✓ Duplicate RPC successfully deduplicated, exactly-once execution guaranteed
Test 3: Concurrent Multi-Client Appends (Race Condition & Lost Update Prevention)...
  Combined string length: 45
  ✓ All 15 concurrent updates safely serialized with zero lost updates
✓ KV Store Consistency Tests Passed!

--- Running Log Compaction & InstallSnapshot Tests (MIT 6.824 Lab 2D / 3B) ---
Test 1: Log Compaction on Growing State...
  Leader firstLogIndex after compaction: 14
  ✓ Log successfully compacted into snapshot, bound memory consumption
Test 2: InstallSnapshot Catchup for Lagging Follower...
  Disconnecting Follower Node 2...
  Leader has now compacted up to index: 30
  Follower Node 2 lastApplied index is: 15
  Reconnecting Follower Node 2 (forcing InstallSnapshot RPC)...
  Follower Node 2 lastApplied after catchup: 30
  ✓ Follower successfully received InstallSnapshot, restored state machine, and caught up!
✓ Log Compaction & InstallSnapshot Tests Passed!

--- Running Disk Persistence & Crash Recovery Tests (MIT 6.824 Lab 2C) ---
Step 1: Starting cluster with file-backed disk storage...
Step 2: Committing operations before power failure...
  Committed at term: 2
Step 3: Simulating catastrophic power outage (crashing ALL 3 servers simultaneously)...
  ✓ Verified state files written to disk
Step 4: Rebooting cluster from disk files...
Step 5: Verifying data durability and continuing operations...
  ✓ All committed keys and values survived total cluster reboot without loss!
  ✓ Post-recovery operations succeeded smoothly
✓ Disk Persistence & Crash Recovery Tests Passed!

========================================================================
                         TEST RESULTS SUMMARY
========================================================================
┌─────────┬─────────────────────────────────────────────────────────────────┬──────────┬─────────┐
│ (index) │ module                                                          │ status   │ time    │
├─────────┼─────────────────────────────────────────────────────────────────┼──────────┼─────────┤
│ 0       │ '1. Leader Election & Heartbeats (Lab 2A)'                      │ 'PASSED' │ '2.44s' │
│ 1       │ '2. Log Replication & Quorum Agreement (Lab 2B)'                │ 'PASSED' │ '3.14s' │
│ 2       │ '3. Network Partitions & Split-Brain Prevention (Lab 2B/2C)'    │ 'PASSED' │ '3.58s' │
│ 3       │ '4. Key-Value Linearizability & Deduplication (Lab 3A)'         │ 'PASSED' │ '0.75s' │
│ 4       │ '5. Log Compaction & InstallSnapshot (Lab 2D/3B)'               │ 'PASSED' │ '2.04s' │
│ 5       │ '6. Durable Persistence & Catastrophic Crash Recovery (Lab 2C)' │ 'PASSED' │ '2.01s' │
└─────────┴─────────────────────────────────────────────────────────────────┴──────────┴─────────┘

Results: 6/6 Test Suites Passed in 13.96s
🎉 ALL DISTRIBUTED SYSTEMS SAFETY & LIVENESS INVARIANTS SATISFIED!
```

---

## Interactive Dashboard & Screenshot Previews

### Dashboard Interface Layout
```
+-------------------------------------------------------------------------------------------------------+
|  ⚡ DistriKV Cluster Visualizer    Cluster Size: 5 Nodes | Leader: Node 1 (Term 3) | Quorum: Healthy   |
+-------------------------------------------------------------------------------------------------------+
|  [⚡ Isolate Leader]  [🔪 Split Partition (2 vs 3)]  [💚 Heal Network]  [🐒 Run Live Chaos Monkey]     |
+-------------------------------------------------------------------------------------------------------+
|  +------------------+  +------------------+  +------------------+  +------------------+  +----------+ |
|  | Node 0           |  | Node 1 [LEADER]  |  | Node 2           |  | Node 3           |  | Node 4   | |
|  | State: FOLLOWER  |  | State: LEADER    |  | State: FOLLOWER  |  | State: FOLLOWER  |  | FOLLOWER | |
|  | Term: 3          |  | Term: 3          |  | Term: 3          |  | Term: 3          |  | Term: 3  | |
|  | Commit: 18       |  | Commit: 18       |  | Commit: 18       |  | Commit: 18       |  | Commit:18| |
|  | [Log Entries]    |  | [Log Entries]    |  | [Log Entries]    |  | [Log Entries]    |  | [Log...] | |
|  | [KV: balance=100]|  | [KV: balance=100]|  | [KV: balance=100]|  | [KV: balance=100]|  | [KV...]  | |
|  | [Crash Node]     |  | [Crash Node]     |  | [Crash Node]     |  | [Crash Node]     |  | [Crash]  | |
|  +------------------+  +------------------+  +------------------+  +------------------+  +----------+ |
+-------------------------------------------------------------------------------------------------------+
|  [🎮 Interactive Client Console]                        [📡 Live RPC Traffic & Invariant Stream]      |
|  Key: [ balance          ]  Value: [ 100         ]      14:44:02 Node 1 -> Node 2 APPEND_ENTRIES  ✓  |
|  [PUT]  [APPEND]  [GET]                                 14:44:02 Node 1 -> Node 3 APPEND_ENTRIES  ✓  |
|  ✓ PUT OK! Response: "100" via Node 1 in 12ms           14:44:02 Node 1 -> Node 4 APPEND_ENTRIES  ✓  |
+-------------------------------------------------------------------------------------------------------+
```

---

## MIT 6.824 Reference Mapping

This project maps directly to the syllabus, problem sets, and architecture of **MIT 6.824 / 6.5840: Distributed Systems**:

1. **Lab 2A (Leader Election)**:
   - Randomized election timeout intervals: avoids split-vote deadlocks.
   - Heartbeat broadcasting and term step-down upon discovering newer terms.
   - Reference: `src/raft/raft.js` (`handleElectionTimeout`, `handleRequestVote`, `stepDown`).

2. **Lab 2B (Log Replication)**:
   - Log consistency check (`prevLogIndex`, `prevLogTerm`).
   - Fast backtracking using `conflictIndex` and `conflictTerm` to eliminate log discrepancy within one RTT.
   - Leader commit index advance on majority replication.
   - Reference: `src/raft/raft.js` (`handleAppendEntries`, `checkAndUpdateCommitIndex`).

3. **Lab 2C (Persistence)**:
   - Atomic disk synchronization of `currentTerm`, `votedFor`, and log entries before responding to RPCs.
   - Reference: `src/raft/persister.js` (`saveRaftState`, `loadFromDisk`).

4. **Lab 2D / 3B (Log Compaction & Snapshots)**:
   - Log compaction with offset indexing (`RaftLog.compact`).
   - `InstallSnapshot` RPC delivery to slow/rejoined followers.
   - Reference: `src/raft/log.js`, `src/raft/raft.js` (`handleInstallSnapshot`).

5. **Lab 3A (Key/Value Service without Snapshots)**:
   - Linearizability and duplicate suppression via `clientId` and `seq` tracking.
   - Decoupled apply loop delivering committed commands to the state machine.
   - Reference: `src/kv/server.js`, `src/kv/client.js`.
