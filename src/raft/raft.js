import EventEmitter from 'node:events';
import { NodeState, RPCType } from '../common/types.js';
import { RaftLog } from './log.js';
import { randomRange, Logger } from '../common/utils.js';

export class RaftNode extends EventEmitter {
  constructor(nodeId, peers, persister, applyCallback, options = {}) {
    super();
    this.nodeId = nodeId;
    this.peers = peers; // Array of peer node IDs
    this.persister = persister;
    this.applyCallback = applyCallback;

    this.options = {
      electionTimeoutMin: options.electionTimeoutMin || 200,
      electionTimeoutMax: options.electionTimeoutMax || 400,
      heartbeatInterval: options.heartbeatInterval || 60,
      logger: options.logger || new Logger(nodeId, false),
      ...options
    };

    this.logger = this.options.logger;

    // Persistent state on all servers
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = new RaftLog();

    // Volatile state on all servers
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.state = NodeState.FOLLOWER;

    // Volatile state on leaders
    this.nextIndex = new Map();
    this.matchIndex = new Map();

    // Timers & intervals
    this.electionTimer = null;
    this.heartbeatIntervalTimer = null;
    this.applyRunning = false;
    this.isKilled = false;

    // Network / RPC caller (set by network or cluster)
    this.sendRPC = options.sendRPC || (async () => null);

    // Read saved state if available
    this.readPersist();

    // Start election timer
    this.resetElectionTimer();
  }

  // -------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------
  persist() {
    const state = {
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      log: this.log.serialize()
    };
    this.persister.saveRaftState(state);
  }

  readPersist() {
    const state = this.persister.readRaftState();
    if (!state) return;

    this.currentTerm = state.currentTerm || 0;
    this.votedFor = state.votedFor !== undefined ? state.votedFor : null;
    if (state.log) {
      this.log = RaftLog.deserialize(state.log);
      this.lastApplied = this.log.getFirstLogIndex();
      this.commitIndex = this.log.getFirstLogIndex();
    }
  }

  // -------------------------------------------------------------
  // Public Raft Interface
  // -------------------------------------------------------------
  getState() {
    return {
      term: this.currentTerm,
      isLeader: this.state === NodeState.LEADER,
      state: this.state,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      lastLogIndex: this.log.getLastLogIndex(),
      lastLogTerm: this.log.getLastLogTerm(),
      firstLogIndex: this.log.getFirstLogIndex()
    };
  }

  /**
   * Start proposing a command.
   * Returns: { index, term, isLeader }
   */
  start(command) {
    if (this.isKilled || this.state !== NodeState.LEADER) {
      return { index: -1, term: this.currentTerm, isLeader: false };
    }

    const index = this.log.append(command, this.currentTerm);
    this.persist();
    this.matchIndex.set(this.nodeId, index);
    this.nextIndex.set(this.nodeId, index + 1);

    this.logger.log(`Leader received command at index ${index}, term ${this.currentTerm}`);

    // Trigger immediate replication
    this.broadcastAppendEntries();

    return { index, term: this.currentTerm, isLeader: true };
  }

  /**
   * State machine compacts log up to index
   */
  snapshot(index, snapshotData) {
    if (index <= this.log.getFirstLogIndex() || index > this.commitIndex) {
      return; // Cannot snapshot beyond commit index or already snapshotted
    }

    const term = this.log.getTerm(index);
    if (!this.log.compact(index, term)) {
      return;
    }

    const state = {
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      log: this.log.serialize()
    };
    this.persister.saveStateAndSnapshot(state, snapshotData);
    this.logger.log(`Snapshotted up to index ${index}, term ${term}`);
  }

  // -------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------
  resetElectionTimer() {
    if (this.isKilled) return;
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
    }
    const timeout = randomRange(this.options.electionTimeoutMin, this.options.electionTimeoutMax);
    this.electionTimer = setTimeout(() => {
      this.handleElectionTimeout();
    }, timeout);
  }

  stopTimers() {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
  }

  // -------------------------------------------------------------
  // Election Logic (with Pre-Vote optimization)
  // -------------------------------------------------------------
  handleElectionTimeout() {
    if (this.isKilled || this.state === NodeState.LEADER) return;
    this.startPreVote();
  }

  startPreVote() {
    this.resetElectionTimer();
    const nextTerm = this.currentTerm + 1;
    const lastLogIndex = this.log.getLastLogIndex();
    const lastLogTerm = this.log.getLastLogTerm();
    let preVotes = 1; // Self
    const quorum = Math.floor(this.peers.length / 2) + 1;

    if (preVotes >= quorum) {
      this.startElection();
      return;
    }

    for (const peerId of this.peers) {
      if (peerId === this.nodeId) continue;

      const args = {
        type: RPCType.PRE_VOTE,
        term: nextTerm,
        candidateId: this.nodeId,
        lastLogIndex,
        lastLogTerm
      };

      this.sendRPC(peerId, args).then(reply => {
        if (!reply || this.isKilled || this.state === NodeState.LEADER) return;

        if (reply.term > this.currentTerm) {
          this.stepDown(reply.term);
          return;
        }

        if (reply.voteGranted) {
          preVotes++;
          if (preVotes >= quorum && this.state !== NodeState.LEADER) {
            this.startElection();
          }
        }
      }).catch(() => {});
    }
  }

  handlePreVote(args) {
    if (this.isKilled) return { term: this.currentTerm, voteGranted: false };
    if (args.term < this.currentTerm) return { term: this.currentTerm, voteGranted: false };

    const myLastTerm = this.log.getLastLogTerm();
    const myLastIndex = this.log.getLastLogIndex();
    const logOk = (args.lastLogTerm > myLastTerm) ||
                  (args.lastLogTerm === myLastTerm && args.lastLogIndex >= myLastIndex);

    return { term: this.currentTerm, voteGranted: logOk };
  }

  startElection() {
    this.state = NodeState.CANDIDATE;
    this.currentTerm += 1;
    this.votedFor = this.nodeId;
    this.persist();
    this.resetElectionTimer();

    this.logger.log(`Starting election for term ${this.currentTerm}`);
    this.emit('stateChange', this.getState());

    let votesReceived = 1; // Voted for self
    const electionTerm = this.currentTerm;
    const lastLogIndex = this.log.getLastLogIndex();
    const lastLogTerm = this.log.getLastLogTerm();
    const quorum = Math.floor(this.peers.length / 2) + 1;

    if (votesReceived >= quorum) {
      this.becomeLeader();
      return;
    }

    for (const peerId of this.peers) {
      if (peerId === this.nodeId) continue;

      const args = {
        type: RPCType.REQUEST_VOTE,
        term: electionTerm,
        candidateId: this.nodeId,
        lastLogIndex,
        lastLogTerm
      };

      this.sendRPC(peerId, args).then(reply => {
        if (!reply || this.isKilled) return;

        // Check if reply term is higher
        if (reply.term > this.currentTerm) {
          this.stepDown(reply.term);
          return;
        }

        // Verify we are still candidate in the same term
        if (this.state === NodeState.CANDIDATE && this.currentTerm === electionTerm && reply.voteGranted) {
          votesReceived++;
          if (votesReceived >= quorum) {
            this.becomeLeader();
          }
        }
      }).catch(() => {});
    }
  }

  becomeLeader() {
    if (this.state !== NodeState.CANDIDATE) return;

    this.state = NodeState.LEADER;
    this.logger.log(`Won election! Became LEADER for term ${this.currentTerm}`);

    const lastLogIndex = this.log.getLastLogIndex();
    for (const peerId of this.peers) {
      this.nextIndex.set(peerId, lastLogIndex + 1);
      this.matchIndex.set(peerId, 0);
    }
    this.matchIndex.set(this.nodeId, lastLogIndex);

    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    // Immediately send heartbeats
    this.broadcastAppendEntries();

    // Start periodic heartbeats
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
    }
    this.heartbeatIntervalTimer = setInterval(() => {
      if (this.state === NodeState.LEADER && !this.isKilled) {
        this.broadcastAppendEntries();
      }
    }, this.options.heartbeatInterval);

    this.emit('stateChange', this.getState());
  }

  stepDown(newTerm) {
    this.state = NodeState.FOLLOWER;
    this.currentTerm = newTerm;
    this.votedFor = null;
    this.persist();

    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    this.resetElectionTimer();
    this.emit('stateChange', this.getState());
  }

  // -------------------------------------------------------------
  // RequestVote RPC Handler (Server-side)
  // -------------------------------------------------------------
  handleRequestVote(args) {
    if (this.isKilled) {
      return { term: this.currentTerm, voteGranted: false };
    }

    // Rule 1: If term < currentTerm, reject
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }

    // If term > currentTerm, update term and convert to follower
    if (args.term > this.currentTerm) {
      this.stepDown(args.term);
    }

    // Rule 2: If votedFor is null or candidateId, and candidate's log is up-to-date
    const canVote = (this.votedFor === null || this.votedFor === args.candidateId);

    const myLastTerm = this.log.getLastLogTerm();
    const myLastIndex = this.log.getLastLogIndex();

    // Raft Section 5.4.1 Election restriction:
    // Candidate log is at least as up-to-date as receiver log
    const logOk = (args.lastLogTerm > myLastTerm) ||
                  (args.lastLogTerm === myLastTerm && args.lastLogIndex >= myLastIndex);

    if (canVote && logOk) {
      this.votedFor = args.candidateId;
      this.persist();
      this.resetElectionTimer();
      this.logger.log(`Voted for candidate ${args.candidateId} in term ${this.currentTerm}`);
      return { term: this.currentTerm, voteGranted: true };
    }

    return { term: this.currentTerm, voteGranted: false };
  }

  // -------------------------------------------------------------
  // Log Replication & AppendEntries
  // -------------------------------------------------------------
  broadcastAppendEntries() {
    if (this.state !== NodeState.LEADER || this.isKilled) return;

    for (const peerId of this.peers) {
      if (peerId === this.nodeId) continue;
      this.sendAppendEntriesToPeer(peerId);
    }
  }

  sendAppendEntriesToPeer(peerId) {
    if (this.state !== NodeState.LEADER || this.isKilled) return;

    const nextIdx = this.nextIndex.get(peerId) || 1;
    const firstIdx = this.log.getFirstLogIndex();

    // If follower is behind our compacted log, send InstallSnapshot instead!
    if (nextIdx <= firstIdx) {
      this.sendInstallSnapshotToPeer(peerId);
      return;
    }

    const prevLogIndex = nextIdx - 1;
    const prevLogTerm = this.log.getTerm(prevLogIndex);
    const entries = this.log.getSlice(nextIdx);

    const args = {
      type: RPCType.APPEND_ENTRIES,
      term: this.currentTerm,
      leaderId: this.nodeId,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex
    };

    const currentTerm = this.currentTerm;

    this.sendRPC(peerId, args).then(reply => {
      if (!reply || this.isKilled || this.state !== NodeState.LEADER || this.currentTerm !== currentTerm) {
        return;
      }

      if (reply.term > this.currentTerm) {
        this.stepDown(reply.term);
        return;
      }

      if (reply.success) {
        const newMatch = prevLogIndex + entries.length;
        this.matchIndex.set(peerId, Math.max(this.matchIndex.get(peerId) || 0, newMatch));
        this.nextIndex.set(peerId, this.matchIndex.get(peerId) + 1);

        // Check if we can advance commitIndex
        this.checkAndUpdateCommitIndex();
      } else {
        // Fast log backtracking (conflict index & term)
        if (reply.conflictTerm !== null && reply.conflictTerm !== undefined) {
          let foundTermIdx = -1;
          for (let i = this.log.getLastLogIndex(); i >= this.log.getFirstLogIndex(); i--) {
            if (this.log.getTerm(i) === reply.conflictTerm) {
              foundTermIdx = i;
              break;
            }
          }
          if (foundTermIdx !== -1) {
            this.nextIndex.set(peerId, foundTermIdx + 1);
          } else {
            this.nextIndex.set(peerId, Math.max(1, reply.conflictIndex));
          }
        } else if (reply.conflictIndex !== undefined && reply.conflictIndex !== null) {
          this.nextIndex.set(peerId, Math.max(1, reply.conflictIndex));
        } else {
          this.nextIndex.set(peerId, Math.max(1, nextIdx - 1));
        }

        // Retry right away
        this.sendAppendEntriesToPeer(peerId);
      }
    }).catch(() => {});
  }

  checkAndUpdateCommitIndex() {
    if (this.state !== NodeState.LEADER) return;

    const lastLogIndex = this.log.getLastLogIndex();
    const quorum = Math.floor(this.peers.length / 2) + 1;

    for (let N = lastLogIndex; N > this.commitIndex; N--) {
      // Leader can only commit an entry from its current term directly (Raft Sec 5.4.2)
      if (this.log.getTerm(N) !== this.currentTerm) {
        continue;
      }

      let count = 1; // Self
      for (const peerId of this.peers) {
        if (peerId !== this.nodeId && (this.matchIndex.get(peerId) || 0) >= N) {
          count++;
        }
      }

      if (count >= quorum) {
        this.commitIndex = N;
        this.logger.log(`Leader advanced commitIndex to ${this.commitIndex}`);
        this.triggerApply();
        break;
      }
    }
  }

  // -------------------------------------------------------------
  // AppendEntries RPC Handler (Server-side)
  // -------------------------------------------------------------
  handleAppendEntries(args) {
    if (this.isKilled) {
      return { term: this.currentTerm, success: false };
    }

    // Rule 1: Reply false if term < currentTerm
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    // Valid leader active: reset election timer
    if (args.term > this.currentTerm || this.state === NodeState.CANDIDATE) {
      this.stepDown(args.term);
    } else {
      this.resetElectionTimer();
    }

    const firstIndex = this.log.getFirstLogIndex();
    const lastIndex = this.log.getLastLogIndex();

    // Check if prevLogIndex is older than snapshot
    if (args.prevLogIndex < firstIndex) {
      return {
        term: this.currentTerm,
        success: false,
        conflictIndex: firstIndex + 1,
        conflictTerm: null
      };
    }

    // Rule 2: Reply false if log doesn't contain an entry at prevLogIndex matching prevLogTerm
    if (args.prevLogIndex > lastIndex) {
      return {
        term: this.currentTerm,
        success: false,
        conflictIndex: lastIndex + 1,
        conflictTerm: null
      };
    }

    const termAtPrev = this.log.getTerm(args.prevLogIndex);
    if (termAtPrev !== args.prevLogTerm) {
      const conflictTerm = termAtPrev;
      let conflictIndex = args.prevLogIndex;
      // Find first index for this term
      for (let i = args.prevLogIndex; i >= firstIndex; i--) {
        if (this.log.getTerm(i) === conflictTerm) {
          conflictIndex = i;
        } else {
          break;
        }
      }
      return {
        term: this.currentTerm,
        success: false,
        conflictIndex,
        conflictTerm
      };
    }

    // Rule 3 & 4: Append new entries and truncate conflicts
    if (args.entries && args.entries.length > 0) {
      this.log.truncateAndAppend(args.prevLogIndex, args.entries);
      this.persist();
    }

    // Rule 5: If leaderCommit > commitIndex, set commitIndex = min(leaderCommit, index of last new entry)
    if (args.leaderCommit > this.commitIndex) {
      const lastNewEntryIndex = args.prevLogIndex + (args.entries ? args.entries.length : 0);
      this.commitIndex = Math.min(args.leaderCommit, lastNewEntryIndex);
      this.triggerApply();
    }

    return {
      term: this.currentTerm,
      success: true,
      matchIndex: args.prevLogIndex + (args.entries ? args.entries.length : 0)
    };
  }

  // -------------------------------------------------------------
  // InstallSnapshot RPC
  // -------------------------------------------------------------
  sendInstallSnapshotToPeer(peerId) {
    const snapshot = this.persister.readSnapshot();
    const args = {
      type: RPCType.INSTALL_SNAPSHOT,
      term: this.currentTerm,
      leaderId: this.nodeId,
      lastIncludedIndex: this.log.getFirstLogIndex(),
      lastIncludedTerm: this.log.lastIncludedTerm,
      data: snapshot
    };

    const currentTerm = this.currentTerm;
    this.sendRPC(peerId, args).then(reply => {
      if (!reply || this.isKilled || this.state !== NodeState.LEADER || this.currentTerm !== currentTerm) {
        return;
      }

      if (reply.term > this.currentTerm) {
        this.stepDown(reply.term);
        return;
      }

      this.matchIndex.set(peerId, Math.max(this.matchIndex.get(peerId) || 0, args.lastIncludedIndex));
      this.nextIndex.set(peerId, this.matchIndex.get(peerId) + 1);
    }).catch(() => {});
  }

  handleInstallSnapshot(args) {
    if (this.isKilled) {
      return { term: this.currentTerm };
    }

    if (args.term < this.currentTerm) {
      return { term: this.currentTerm };
    }

    if (args.term > this.currentTerm) {
      this.stepDown(args.term);
    } else {
      this.resetElectionTimer();
    }

    if (args.lastIncludedIndex <= this.lastApplied) {
      return { term: this.currentTerm };
    }

    // Apply snapshot to log and persist
    this.log.compact(args.lastIncludedIndex, args.lastIncludedTerm);
    const state = {
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      log: this.log.serialize()
    };
    this.persister.saveStateAndSnapshot(state, args.data);

    this.commitIndex = Math.max(this.commitIndex, args.lastIncludedIndex);
    this.lastApplied = Math.max(this.lastApplied, args.lastIncludedIndex);

    // Deliver snapshot to state machine
    if (this.applyCallback) {
      this.applyCallback({
        snapshotValid: true,
        snapshot: args.data,
        snapshotIndex: args.lastIncludedIndex,
        snapshotTerm: args.lastIncludedTerm
      });
    }

    return { term: this.currentTerm };
  }

  // -------------------------------------------------------------
  // Apply Loop
  // -------------------------------------------------------------
  triggerApply() {
    if (this.applyRunning) return;
    this.applyRunning = true;

    setImmediate(() => {
      this.applyEntries();
      this.applyRunning = false;
    });
  }

  applyEntries() {
    while (this.commitIndex > this.lastApplied && !this.isKilled) {
      this.lastApplied++;
      const entry = this.log.getEntry(this.lastApplied);
      if (entry && entry.command !== null && this.applyCallback) {
        this.applyCallback({
          commandValid: true,
          command: entry.command,
          commandIndex: entry.index,
          commandTerm: entry.term
        });
      }
    }
  }

  // -------------------------------------------------------------
  // Crash / Restart lifecycle
  // -------------------------------------------------------------
  kill() {
    this.isKilled = true;
    this.state = NodeState.CRASHED;
    this.stopTimers();
    this.emit('stateChange', this.getState());
  }

  restart() {
    this.isKilled = false;
    this.state = NodeState.FOLLOWER;
    this.readPersist();
    this.resetElectionTimer();
    this.emit('stateChange', this.getState());
  }
}
