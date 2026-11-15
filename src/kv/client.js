import { ErrorCode } from '../common/types.js';
import { generateClientId, sleep } from '../common/utils.js';

export class KVClient {
  constructor(servers, options = {}) {
    this.servers = servers; // Array of server endpoints or node references
    this.clientId = options.clientId || generateClientId();
    this.seq = 0;
    this.knownLeader = 0;
    this.sendHandler = options.sendHandler || null; // Custom handler if using network simulator or HTTP
    this.retryTimeoutMs = options.retryTimeoutMs || 3000;
  }

  async get(key) {
    this.seq++;
    const currentSeq = this.seq;

    while (true) {
      const server = this.servers[this.knownLeader];
      try {
        let res;
        if (this.sendHandler) {
          res = await this.sendHandler(this.knownLeader, {
            type: 'GET',
            key,
            clientId: this.clientId,
            seq: currentSeq
          });
        } else if (server && typeof server.get === 'function') {
          res = await server.get(key, this.clientId, currentSeq);
        }

        if (res && res.err === ErrorCode.OK) {
          return res.value || '';
        }
      } catch (err) {
        // Network error / node down
      }

      // Try next server
      this.knownLeader = (this.knownLeader + 1) % this.servers.length;
      await sleep(40);
    }
  }

  async put(key, value) {
    this.seq++;
    const currentSeq = this.seq;

    while (true) {
      const server = this.servers[this.knownLeader];
      try {
        let res;
        if (this.sendHandler) {
          res = await this.sendHandler(this.knownLeader, {
            type: 'PUT',
            key,
            value,
            clientId: this.clientId,
            seq: currentSeq
          });
        } else if (server && typeof server.put === 'function') {
          res = await server.put(key, value, this.clientId, currentSeq);
        }

        if (res && res.err === ErrorCode.OK) {
          return;
        }
      } catch (err) {
        // Network error / node down
      }

      // Try next server
      this.knownLeader = (this.knownLeader + 1) % this.servers.length;
      await sleep(40);
    }
  }

  async append(key, value) {
    this.seq++;
    const currentSeq = this.seq;

    while (true) {
      const server = this.servers[this.knownLeader];
      try {
        let res;
        if (this.sendHandler) {
          res = await this.sendHandler(this.knownLeader, {
            type: 'APPEND',
            key,
            value,
            clientId: this.clientId,
            seq: currentSeq
          });
        } else if (server && typeof server.append === 'function') {
          res = await server.append(key, value, this.clientId, currentSeq);
        }

        if (res && res.err === ErrorCode.OK) {
          return res.value;
        }
      } catch (err) {
        // Network error / node down
      }

      // Try next server
      this.knownLeader = (this.knownLeader + 1) % this.servers.length;
      await sleep(40);
    }
  }
}
