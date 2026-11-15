import http from 'node:http';
import { RPCType } from '../common/types.js';

export class NodeHttpServer {
  constructor(nodeId, serverInstance, port) {
    this.nodeId = nodeId;
    this.serverInstance = serverInstance;
    this.port = port;
    this.httpServer = null;
  }

  start() {
    return new Promise((resolve) => {
      this.httpServer = http.createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://localhost:${this.port}`);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          let parsed = {};
          if (body) {
            try { parsed = JSON.parse(body); } catch (_) {}
          }

          try {
            if (url.pathname === '/status' && req.method === 'GET') {
              const state = this.serverInstance.getState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(state));
              return;
            }

            if (url.pathname === '/raft/rpc' && req.method === 'POST') {
              let reply = null;
              if (parsed.type === RPCType.REQUEST_VOTE) {
                reply = this.serverInstance.raft.handleRequestVote(parsed);
              } else if (parsed.type === RPCType.APPEND_ENTRIES) {
                reply = this.serverInstance.raft.handleAppendEntries(parsed);
              } else if (parsed.type === RPCType.INSTALL_SNAPSHOT) {
                reply = this.serverInstance.raft.handleInstallSnapshot(parsed);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(reply));
              return;
            }

            if (url.pathname === '/kv/request' && req.method === 'POST') {
              const result = await this.serverInstance.handleClientRequest(parsed);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
              return;
            }

            if (url.pathname === '/admin/kill' && req.method === 'POST') {
              this.serverInstance.kill();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'killed' }));
              return;
            }

            if (url.pathname === '/admin/restart' && req.method === 'POST') {
              this.serverInstance.restart();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'restarted' }));
              return;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      this.httpServer.listen(this.port, () => {
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
