import { RPCType } from '../common/types.js';
import { sleep, randomRange } from '../common/utils.js';

/**
 * NetworkSimulator simulates a distributed network environment
 * modeled after MIT 6.824 LabRPC.
 * Allows simulating:
 *  - Node crashes / disconnections
 *  - Network partitions (split brain tests)
 *  - Packet loss & transmission delay
 */
export class NetworkSimulator {
  constructor(options = {}) {
    this.nodes = new Map(); // nodeId -> KVServer
    this.disabledNodes = new Set(); // Node IDs that are completely disconnected
    this.partitionMap = new Map(); // nodeId -> Set of reachable nodeIds
    this.dropRate = options.dropRate || 0.0;
    this.latencyMin = options.latencyMin || 0;
    this.latencyMax = options.latencyMax || 0;
    this.rpcHistory = []; // Event log for visualization
    this.maxHistory = 100;
  }

  registerNode(nodeId, server) {
    this.nodes.set(nodeId, server);
    // Wire node's sendRPC to simulator
    server.raft.sendRPC = (peerId, rpc) => this.dispatchRPC(nodeId, peerId, rpc);
  }

  // -------------------------------------------------------------
  // Partition & Failure Injection
  // -------------------------------------------------------------
  disconnect(nodeId) {
    this.disabledNodes.add(nodeId);
  }

  connect(nodeId) {
    this.disabledNodes.delete(nodeId);
    if (this.partitionMap.has(nodeId)) {
      this.partitionMap.delete(nodeId);
    }
  }

  /**
   * Partition the cluster into isolated subsets.
   * e.g., partition([[0, 1], [2, 3, 4]])
   */
  setPartition(partitions) {
    this.partitionMap.clear();
    for (const group of partitions) {
      const groupSet = new Set(group);
      for (const id of group) {
        this.partitionMap.set(id, groupSet);
      }
    }
  }

  healPartition() {
    this.partitionMap.clear();
  }

  isReachable(fromId, toId) {
    if (this.disabledNodes.has(fromId) || this.disabledNodes.has(toId)) {
      return false;
    }

    if (this.partitionMap.size > 0) {
      const group = this.partitionMap.get(fromId);
      if (!group || !group.has(toId)) {
        return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------
  // Dispatch RPC
  // -------------------------------------------------------------
  async dispatchRPC(fromId, toId, rpc) {
    // Record for visualizer
    const rpcRecord = {
      timestamp: Date.now(),
      from: fromId,
      to: toId,
      type: rpc.type,
      term: rpc.term,
      dropped: false
    };

    // Check reachability
    if (!this.isReachable(fromId, toId)) {
      rpcRecord.dropped = true;
      this.recordRpc(rpcRecord);
      return null;
    }

    // Packet drop simulation
    if (this.dropRate > 0 && Math.random() < this.dropRate) {
      rpcRecord.dropped = true;
      this.recordRpc(rpcRecord);
      return null;
    }

    // Delay simulation
    if (this.latencyMax > 0) {
      const delay = randomRange(this.latencyMin, this.latencyMax);
      await sleep(delay);
    }

    const targetServer = this.nodes.get(toId);
    if (!targetServer || targetServer.isKilled) {
      rpcRecord.dropped = true;
      this.recordRpc(rpcRecord);
      return null;
    }

    let reply = null;
    try {
      if (rpc.type === RPCType.PRE_VOTE) {
        reply = targetServer.raft.handlePreVote(rpc);
      } else if (rpc.type === RPCType.REQUEST_VOTE) {
        reply = targetServer.raft.handleRequestVote(rpc);
      } else if (rpc.type === RPCType.APPEND_ENTRIES) {
        reply = targetServer.raft.handleAppendEntries(rpc);
      } else if (rpc.type === RPCType.INSTALL_SNAPSHOT) {
        reply = targetServer.raft.handleInstallSnapshot(rpc);
      }
    } catch (err) {
      reply = null;
    }

    // Check return path reachability
    if (!this.isReachable(toId, fromId)) {
      rpcRecord.dropped = true;
      this.recordRpc(rpcRecord);
      return null;
    }

    this.recordRpc(rpcRecord);
    return reply;
  }

  recordRpc(rec) {
    this.rpcHistory.push(rec);
    if (this.rpcHistory.length > this.maxHistory) {
      this.rpcHistory.shift();
    }
  }

  getRecentRPCs() {
    return this.rpcHistory.slice(-30);
  }
}
