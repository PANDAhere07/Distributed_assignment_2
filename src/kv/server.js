import { OpType, ErrorCode, NodeState } from '../common/types.js';
import { RaftNode } from '../raft/raft.js';
import { deepClone, Logger } from '../common/utils.js';

export class KVServer {
  constructor(nodeId, peers, persister, options = {}) {
    this.nodeId = nodeId;
    this.peers = peers;
    this.persister = persister;
    this.maxRaftState = options.maxRaftState || -1; // -1 means no snapshotting threshold

    this.logger = options.logger || new Logger(nodeId, false);

    // In-memory key-value state
    this.kvStore = new Map();

    // Deduplication table: clientId -> { seq, value }
    this.clientAcks = new Map();

    // Pending client requests waiting for commit: index -> { resolve, reject, command, timer }
    this.pendingOps = new Map();

    this.isKilled = false;

    // Initialize Raft node with apply callback
    this.raft = new RaftNode(
      nodeId,
      peers,
      persister,
      (msg) => this.handleApplyMsg(msg),
      {
        logger: this.logger,
        ...options
      }
    );

    // Read initial snapshot if present
    this.readSnapshot();
  }

  readSnapshot() {
    const snapshot = this.persister.readSnapshot();
    if (!snapshot) return;

    if (snapshot.kvStore) {
      this.kvStore = new Map(Object.entries(snapshot.kvStore));
    }
    if (snapshot.clientAcks) {
      this.clientAcks = new Map(Object.entries(snapshot.clientAcks));
    }
  }

  // -------------------------------------------------------------
  // Client Request Handlers (RPC / REST)
  // -------------------------------------------------------------
  async handleClientRequest(op, timeoutMs = 2000) {
    if (this.isKilled || this.raft.state !== NodeState.LEADER) {
      return { err: ErrorCode.NOT_LEADER };
    }

    // Submit command to Raft
    const { index, term, isLeader } = this.raft.start(op);
    if (!isLeader) {
      return { err: ErrorCode.NOT_LEADER };
    }

    // Wait for command to be applied or timeout
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingOps.has(index)) {
          this.pendingOps.delete(index);
          resolve({ err: ErrorCode.TIMEOUT });
        }
      }, timeoutMs);

      this.pendingOps.set(index, {
        resolve,
        term,
        op,
        timer
      });
    });
  }

  async get(key, clientId = 'anon', seq = 0) {
    const op = { type: OpType.GET, key, clientId, seq };
    return this.handleClientRequest(op);
  }

  async put(key, value, clientId, seq) {
    const op = { type: OpType.PUT, key, value, clientId, seq };
    return this.handleClientRequest(op);
  }

  async append(key, value, clientId, seq) {
    const op = { type: OpType.APPEND, key, value, clientId, seq };
    return this.handleClientRequest(op);
  }

  // -------------------------------------------------------------
  // Apply Loop Handling
  // -------------------------------------------------------------
  handleApplyMsg(msg) {
    if (this.isKilled) return;

    if (msg.snapshotValid) {
      this.applySnapshot(msg.snapshot);
      return;
    }

    if (msg.commandValid) {
      const { command, commandIndex, commandTerm } = msg;
      const result = this.executeCommand(command);

      // Notify waiting client if this node proposed it
      if (this.pendingOps.has(commandIndex)) {
        const pending = this.pendingOps.get(commandIndex);
        this.pendingOps.delete(commandIndex);
        clearTimeout(pending.timer);

        // Verify that term hasn't changed (linearizability guarantee)
        if (pending.term === commandTerm &&
            pending.op.clientId === command.clientId &&
            pending.op.seq === command.seq) {
          pending.resolve({ err: ErrorCode.OK, value: result });
        } else {
          pending.resolve({ err: ErrorCode.NOT_LEADER });
        }
      }

      // Check if snapshot needed
      if (this.maxRaftState > 0 && this.persister.raftStateSize() > this.maxRaftState) {
        this.createSnapshot(commandIndex);
      }
    }
  }

  executeCommand(op) {
    const { type, key, value, clientId, seq } = op;
    let result = '';

    const lastAck = this.clientAcks.get(clientId);
    const isDuplicate = lastAck && lastAck.seq >= seq;

    if (type === OpType.GET) {
      result = this.kvStore.get(key) || '';
    } else if (type === OpType.PUT) {
      if (!isDuplicate) {
        this.kvStore.set(key, value);
        this.clientAcks.set(clientId, { seq, value });
      }
      result = this.kvStore.get(key) || '';
    } else if (type === OpType.APPEND) {
      if (!isDuplicate) {
        const cur = this.kvStore.get(key) || '';
        const updated = cur + value;
        this.kvStore.set(key, updated);
        this.clientAcks.set(clientId, { seq, value: updated });
        result = updated;
      } else {
        result = lastAck.value || (this.kvStore.get(key) || '');
      }
    }

    return result;
  }

  createSnapshot(index) {
    const snapshotData = {
      kvStore: Object.fromEntries(this.kvStore),
      clientAcks: Object.fromEntries(this.clientAcks)
    };
    this.raft.snapshot(index, snapshotData);
  }

  applySnapshot(snapshotData) {
    if (!snapshotData) return;
    if (snapshotData.kvStore) {
      this.kvStore = new Map(Object.entries(snapshotData.kvStore));
    }
    if (snapshotData.clientAcks) {
      this.clientAcks = new Map(Object.entries(snapshotData.clientAcks));
    }
  }

  // -------------------------------------------------------------
  // State Inspection
  // -------------------------------------------------------------
  getState() {
    const raftState = this.raft.getState();
    return {
      nodeId: this.nodeId,
      ...raftState,
      kvStore: Object.fromEntries(this.kvStore),
      clientCount: this.clientAcks.size,
      pendingRequests: this.pendingOps.size,
      isKilled: this.isKilled
    };
  }

  kill() {
    this.isKilled = true;
    for (const [index, pending] of this.pendingOps.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ err: ErrorCode.SERVER_STOPPED });
    }
    this.pendingOps.clear();
    this.raft.kill();
  }

  restart() {
    this.isKilled = false;
    this.raft.restart();
    this.readSnapshot();
  }
}
