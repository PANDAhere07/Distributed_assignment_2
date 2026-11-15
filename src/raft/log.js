/**
 * RaftLog manages the log array with snapshot compaction offset support.
 * Index starts at 1 logically.
 * Index 0 / lastIncludedIndex acts as a sentinel.
 */
export class RaftLog {
  constructor(lastIncludedIndex = 0, lastIncludedTerm = 0, entries = null) {
    this.lastIncludedIndex = lastIncludedIndex;
    this.lastIncludedTerm = lastIncludedTerm;

    if (entries && entries.length > 0) {
      this.entries = entries;
    } else {
      // Sentinel entry representing lastIncludedIndex
      this.entries = [{ index: lastIncludedIndex, term: lastIncludedTerm, command: null }];
    }
  }

  // Convert absolute log index to internal array index
  toInternalIndex(absIndex) {
    return absIndex - this.lastIncludedIndex;
  }

  // Convert internal array index to absolute log index
  toAbsIndex(internalIndex) {
    return internalIndex + this.lastIncludedIndex;
  }

  getLastLogIndex() {
    return this.toAbsIndex(this.entries.length - 1);
  }

  getLastLogTerm() {
    return this.entries[this.entries.length - 1].term;
  }

  getFirstLogIndex() {
    return this.lastIncludedIndex;
  }

  getEntry(absIndex) {
    const idx = this.toInternalIndex(absIndex);
    if (idx < 0 || idx >= this.entries.length) {
      return null;
    }
    return this.entries[idx];
  }

  getTerm(absIndex) {
    if (absIndex === this.lastIncludedIndex) {
      return this.lastIncludedTerm;
    }
    const entry = this.getEntry(absIndex);
    return entry ? entry.term : 0;
  }

  append(command, term) {
    const newIndex = this.getLastLogIndex() + 1;
    const entry = { index: newIndex, term, command };
    this.entries.push(entry);
    return newIndex;
  }

  getSlice(fromAbsIndex) {
    const start = this.toInternalIndex(fromAbsIndex);
    if (start < 0) {
      return [];
    }
    return this.entries.slice(start);
  }

  /**
   * Truncate conflicting entries and append new ones (AppendEntries rule 3 & 4)
   * prevIndex is the index before the new entries.
   */
  truncateAndAppend(prevAbsIndex, newEntries) {
    let insertStart = prevAbsIndex + 1;
    for (let i = 0; i < newEntries.length; i++) {
      const entry = newEntries[i];
      const curAbsIndex = insertStart + i;
      const internalIdx = this.toInternalIndex(curAbsIndex);

      if (internalIdx < this.entries.length) {
        if (this.entries[internalIdx].term !== entry.term) {
          // Conflict: truncate all following entries
          this.entries = this.entries.slice(0, internalIdx);
          this.entries.push(entry);
        }
      } else {
        // Just append
        this.entries.push(entry);
      }
    }
  }

  /**
   * Log compaction up to snapshotIndex
   */
  compact(snapshotIndex, snapshotTerm) {
    if (snapshotIndex <= this.lastIncludedIndex) {
      return false; // Already compacted
    }

    const internalIdx = this.toInternalIndex(snapshotIndex);
    if (internalIdx >= this.entries.length) {
      // Snapshot is ahead of entire log
      this.entries = [{ index: snapshotIndex, term: snapshotTerm, command: null }];
    } else {
      // Retain entries starting from snapshotIndex
      const remaining = this.entries.slice(internalIdx);
      remaining[0] = { index: snapshotIndex, term: snapshotTerm, command: null };
      this.entries = remaining;
    }

    this.lastIncludedIndex = snapshotIndex;
    this.lastIncludedTerm = snapshotTerm;
    return true;
  }

  serialize() {
    return {
      lastIncludedIndex: this.lastIncludedIndex,
      lastIncludedTerm: this.lastIncludedTerm,
      entries: this.entries
    };
  }

  static deserialize(data) {
    return new RaftLog(data.lastIncludedIndex, data.lastIncludedTerm, data.entries);
  }
}
