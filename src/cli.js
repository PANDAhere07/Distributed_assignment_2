#!/usr/bin/env node

/**
 * DistriKV Command-Line Interface (CLI)
 * Interacts with running DistriKV cluster
 */

import readline from 'node:readline';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080/api';

async function sendOp(op, key, value = '') {
  try {
    const res = await fetch(`${API_BASE}/client/op`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, key, value })
    });
    const data = await res.json();
    if (data.error) {
      console.error(`❌ Error (${data.durationMs}ms): ${data.error}`);
    } else {
      console.log(`✅ Success (${data.durationMs}ms) [Leader Node ${data.leaderNode}]:`);
      if (op === 'GET') {
        console.log(`   "${key}" = "${data.value}"`);
      } else {
        console.log(`   Result = "${data.value}"`);
      }
    }
  } catch (err) {
    console.error(`❌ Connection error: ${err.message}. Is the cluster running (npm start)?`);
  }
}

async function showStatus() {
  try {
    const res = await fetch(`${API_BASE}/cluster`);
    const data = await res.json();
    console.log('\n=== DistriKV Cluster Status ===');
    console.table(
      data.nodes.map(n => ({
        Node: n.id,
        State: n.state,
        Term: n.term,
        Leader: n.isLeader ? 'YES' : 'no',
        CommitIdx: n.commitIndex,
        AppliedIdx: n.lastApplied,
        Keys: Object.keys(n.kvStore || {}).length,
        Partitioned: n.isPartitioned ? 'YES' : 'no'
      }))
    );
  } catch (err) {
    console.error(`❌ Unable to fetch cluster status: ${err.message}`);
  }
}

async function runInteractive() {
  console.log('==================================================');
  console.log(' DistriKV Interactive Shell ');
  console.log(' Commands:');
  console.log('   get <key>');
  console.log('   put <key> <value>');
  console.log('   append <key> <value>');
  console.log('   status');
  console.log('   exit');
  console.log('==================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'distrikv> '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    if (cmd === 'exit' || cmd === 'quit') {
      rl.close();
      process.exit(0);
    } else if (cmd === 'status') {
      await showStatus();
    } else if (cmd === 'get' && parts[1]) {
      await sendOp('GET', parts[1]);
    } else if (cmd === 'put' && parts[1]) {
      await sendOp('PUT', parts[1], parts.slice(2).join(' '));
    } else if (cmd === 'append' && parts[1]) {
      await sendOp('APPEND', parts[1], parts.slice(2).join(' '));
    } else if (cmd) {
      console.log('Unknown command. Use: get <key>, put <key> <val>, append <key> <val>, status, exit');
    }
    rl.prompt();
  });
}

const args = process.argv.slice(2);
if (args.length === 0) {
  runInteractive();
} else {
  const cmd = args[0].toLowerCase();
  if (cmd === 'status') {
    showStatus();
  } else if (cmd === 'get') {
    sendOp('GET', args[1]);
  } else if (cmd === 'put') {
    sendOp('PUT', args[1], args.slice(2).join(' '));
  } else if (cmd === 'append') {
    sendOp('APPEND', args[1], args.slice(2).join(' '));
  } else {
    console.log('Usage: node src/cli.js [get|put|append|status] [key] [value]');
  }
}
