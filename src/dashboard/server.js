import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KVServer } from '../kv/server.js';
import { KVClient } from '../kv/client.js';
import { Persister } from '../raft/persister.js';
import { NetworkSimulator } from '../net/network_simulator.js';
import { NodeState } from '../common/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

export class ClusterController {
  constructor(nodeCount = 5) {
    this.nodeCount = nodeCount;
    this.network = new NetworkSimulator();
    this.servers = new Map();
    this.persisters = new Map();
    this.nodeIds = Array.from({ length: nodeCount }, (_, i) => i);
    this.client = null;

    this.initCluster();
  }

  initCluster() {
    for (const id of this.nodeIds) {
      const persister = new Persister(id, path.join(__dirname, '../../data'));
      this.persisters.set(id, persister);

      const server = new KVServer(id, this.nodeIds, persister, {
        electionTimeoutMin: 250,
        electionTimeoutMax: 450,
        heartbeatInterval: 80,
        maxRaftState: 2000
      });

      this.servers.set(id, server);
      this.network.registerNode(id, server);
    }

    // Smart client
    this.client = new KVClient(Array.from(this.servers.values()), {
      sendHandler: async (serverIndex, op) => {
        const s = this.servers.get(serverIndex);
        if (!s || s.isKilled) throw new Error('Node down');
        if (op.type === 'GET') {
          return await s.get(op.key, op.clientId, op.seq);
        } else if (op.type === 'PUT') {
          return await s.put(op.key, op.value, op.clientId, op.seq);
        } else if (op.type === 'APPEND') {
          return await s.append(op.key, op.value, op.clientId, op.seq);
        }
      }
    });
  }

  getClusterState() {
    const nodes = [];
    for (const id of this.nodeIds) {
      const server = this.servers.get(id);
      const state = server.getState();
      const raftLog = server.raft.log.entries.map(e => ({
        index: e.index,
        term: e.term,
        command: e.command
      }));

      nodes.push({
        id,
        state: state.isKilled ? NodeState.CRASHED : state.state,
        term: state.term,
        isLeader: state.isLeader,
        commitIndex: state.commitIndex,
        lastApplied: state.lastApplied,
        log: raftLog,
        kvStore: state.kvStore,
        isKilled: state.isKilled,
        isPartitioned: this.network.disabledNodes.has(id) || this.network.partitionMap.has(id)
      });
    }

    return {
      nodes,
      partitionMap: Array.from(this.network.partitionMap.entries()).map(([k, set]) => [k, Array.from(set)]),
      disabledNodes: Array.from(this.network.disabledNodes),
      recentRPCs: this.network.getRecentRPCs()
    };
  }

  crashNode(id) {
    const s = this.servers.get(id);
    if (s) {
      s.kill();
      this.network.disconnect(id);
    }
  }

  restartNode(id) {
    const s = this.servers.get(id);
    if (s) {
      this.network.connect(id);
      s.restart();
    }
  }

  isolateLeader() {
    const state = this.getClusterState();
    const leader = state.nodes.find(n => n.isLeader);
    if (leader) {
      const others = this.nodeIds.filter(id => id !== leader.id);
      this.network.setPartition([[leader.id], others]);
    }
  }

  splitPartition() {
    // 2 vs 3 partition
    const groupA = this.nodeIds.slice(0, 2);
    const groupB = this.nodeIds.slice(2);
    this.network.setPartition([groupA, groupB]);
  }

  heal() {
    this.network.healPartition();
    for (const id of this.nodeIds) {
      const s = this.servers.get(id);
      if (s && !s.isKilled) {
        this.network.connect(id);
      }
    }
  }
}

// HTTP Server for Dashboard & API
const PORT = process.env.PORT || 8080;
const cluster = new ClusterController(5);

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API Endpoints
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let data = {};
      if (body) {
        try { data = JSON.parse(body); } catch (_) {}
      }

      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/api/cluster' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(cluster.getClusterState()));
        return;
      }

      if (url.pathname === '/api/crash' && req.method === 'POST') {
        cluster.crashNode(Number(data.nodeId));
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/api/restart' && req.method === 'POST') {
        cluster.restartNode(Number(data.nodeId));
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/api/isolate-leader' && req.method === 'POST') {
        cluster.isolateLeader();
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/api/split-partition' && req.method === 'POST') {
        cluster.splitPartition();
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/api/heal' && req.method === 'POST') {
        cluster.heal();
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/api/client/op' && req.method === 'POST') {
        const { op, key, value } = data;
        const start = Date.now();
        let result = null;
        let error = null;

        try {
          if (op === 'GET') {
            result = await cluster.client.get(key);
          } else if (op === 'PUT') {
            await cluster.client.put(key, value);
            result = value;
          } else if (op === 'APPEND') {
            result = await cluster.client.append(key, value);
          }
        } catch (err) {
          error = err.message;
        }

        const duration = Date.now() - start;
        res.writeHead(200);
        res.end(JSON.stringify({
          op,
          key,
          value: result,
          error,
          durationMs: duration,
          leaderNode: cluster.client.knownLeader
        }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Server Error');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================================`);
  console.log(` DistriKV - Fault-Tolerant Replicated Distributed KV Service `);
  console.log(` Dashboard & Live Visualizer running at: http://localhost:${PORT}`);
  console.log(`==================================================================`);
});

export { cluster, server };
