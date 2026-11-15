import fs from 'node:fs';
import path from 'node:path';

/**
 * Persister stores Raft state and snapshot data.
 * Supports both in-memory state and disk durability.
 */
export class Persister {
  constructor(nodeId, dataDir = null) {
    this.nodeId = nodeId;
    this.dataDir = dataDir;
    this.raftstate = null;
    this.snapshot = null;

    if (this.dataDir) {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      this.raftFilePath = path.join(this.dataDir, `raft-state-${this.nodeId}.json`);
      this.snapshotFilePath = path.join(this.dataDir, `snapshot-${this.nodeId}.json`);
      this.loadFromDisk();
    }
  }

  loadFromDisk() {
    try {
      if (this.raftFilePath && fs.existsSync(this.raftFilePath)) {
        const raw = fs.readFileSync(this.raftFilePath, 'utf8');
        this.raftstate = JSON.parse(raw);
      }
      if (this.snapshotFilePath && fs.existsSync(this.snapshotFilePath)) {
        const raw = fs.readFileSync(this.snapshotFilePath, 'utf8');
        this.snapshot = JSON.parse(raw);
      }
    } catch (err) {
      console.error(`Error loading persisted state for node ${this.nodeId}:`, err);
    }
  }

  saveRaftState(state) {
    this.raftstate = state ? JSON.parse(JSON.stringify(state)) : null;
    if (this.dataDir && this.raftstate) {
      try {
        fs.writeFileSync(this.raftFilePath, JSON.stringify(this.raftstate, null, 2), 'utf8');
      } catch (err) {
        console.error(`Error writing raft state for node ${this.nodeId}:`, err);
      }
    }
  }

  readRaftState() {
    return this.raftstate ? JSON.parse(JSON.stringify(this.raftstate)) : null;
  }

  raftStateSize() {
    return this.raftstate ? JSON.stringify(this.raftstate).length : 0;
  }

  saveStateAndSnapshot(state, snapshot) {
    this.saveRaftState(state);
    this.snapshot = snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    if (this.dataDir && this.snapshot) {
      try {
        fs.writeFileSync(this.snapshotFilePath, JSON.stringify(this.snapshot, null, 2), 'utf8');
      } catch (err) {
        console.error(`Error writing snapshot for node ${this.nodeId}:`, err);
      }
    }
  }

  readSnapshot() {
    return this.snapshot ? JSON.parse(JSON.stringify(this.snapshot)) : null;
  }

  clone() {
    const p = new Persister(this.nodeId, null);
    p.raftstate = this.readRaftState();
    p.snapshot = this.readSnapshot();
    return p;
  }
}
