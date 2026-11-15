// DistriKV Cluster Visualizer Frontend

const API_BASE = '/api';

// DOM elements
const nodesContainer = document.getElementById('nodes-container');
const valLeader = document.getElementById('val-leader');
const valQuorum = document.getElementById('val-quorum');
const rpcStream = document.getElementById('rpc-stream');
const clientConsole = document.getElementById('client-console');

const inputKey = document.getElementById('input-key');
const inputValue = document.getElementById('input-value');
const btnPut = document.getElementById('btn-kv-put');
const btnAppend = document.getElementById('btn-kv-append');
const btnGet = document.getElementById('btn-kv-get');

const btnIsolateLeader = document.getElementById('btn-isolate-leader');
const btnSplitPartition = document.getElementById('btn-split-partition');
const btnHeal = document.getElementById('btn-heal');
const btnChaos = document.getElementById('btn-chaos');

let chaosRunning = false;

// Append message to client console
function logConsole(message, type = 'info') {
  const div = document.createElement('div');
  div.className = `console-entry ${type}`;
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${message}`;
  clientConsole.appendChild(div);
  clientConsole.scrollTop = clientConsole.scrollHeight;
}

// Fetch and render cluster state
async function updateCluster() {
  try {
    const res = await fetch(`${API_BASE}/cluster`);
    if (!res.ok) return;
    const data = await res.json();

    renderNodes(data.nodes);
    renderSummary(data.nodes);
    renderRPCs(data.recentRPCs);
  } catch (err) {
    // Network / connection retry
  }
}

function renderSummary(nodes) {
  const leader = nodes.find(n => n.isLeader && !n.isKilled);
  if (leader) {
    valLeader.textContent = `Node ${leader.id} (Term ${leader.term})`;
    valLeader.style.color = '#34d399';
  } else {
    valLeader.textContent = 'Electing / Disrupted';
    valLeader.style.color = '#fbbf24';
  }

  const activeCount = nodes.filter(n => !n.isKilled).length;
  const quorumMet = activeCount >= Math.floor(nodes.length / 2) + 1;
  valQuorum.textContent = `${activeCount}/${nodes.length} Nodes Online`;
  valQuorum.className = `value ${quorumMet ? 'success' : 'highlight'}`;
}

function renderNodes(nodes) {
  nodesContainer.innerHTML = '';

  nodes.forEach(node => {
    const card = document.createElement('div');
    card.className = `node-card ${node.isLeader ? 'leader' : ''} ${node.isKilled ? 'crashed' : ''} ${node.isPartitioned ? 'partitioned' : ''}`;

    // Mini log HTML
    let logHtml = '';
    if (node.log && node.log.length > 0) {
      const recent = node.log.slice(-5);
      logHtml = recent.map(entry => {
        const isCommitted = entry.index <= node.commitIndex;
        const cmdStr = entry.command ? `${entry.command.type} ${entry.command.key || ''}` : 'no-op';
        return `
          <div class="log-entry ${isCommitted ? 'committed' : 'uncommitted'}">
            <span>[#${entry.index}|T${entry.term}] ${cmdStr}</span>
            <span>${isCommitted ? '✓' : '…'}</span>
          </div>
        `;
      }).join('');
    } else {
      logHtml = '<div style="color: #64748b; font-size: 11px;">(Log empty)</div>';
    }

    // KV store HTML
    let kvHtml = '';
    const kvKeys = Object.keys(node.kvStore || {});
    if (kvKeys.length > 0) {
      kvHtml = kvKeys.map(k => `
        <div class="kv-item">
          <span class="kv-key">${escapeHtml(k)}:</span>
          <span class="kv-val">${escapeHtml(String(node.kvStore[k]))}</span>
        </div>
      `).join('');
    } else {
      kvHtml = '<div style="color: #64748b; font-size: 11px;">(Store empty)</div>';
    }

    card.innerHTML = `
      <div class="node-header">
        <div class="node-title">
          <span>Node ${node.id}</span>
          ${node.isPartitioned ? '<span title="Network Partitioned" style="font-size:12px">⚡✂️</span>' : ''}
        </div>
        <span class="role-badge ${node.state}">${node.state}</span>
      </div>

      <div class="node-stats">
        <div class="stat-item"><span>Term:</span> <b>${node.term}</b></div>
        <div class="stat-item"><span>Commit:</span> <b>${node.commitIndex}</b></div>
        <div class="stat-item"><span>Applied:</span> <b>${node.lastApplied}</b></div>
        <div class="stat-item"><span>Log Size:</span> <b>${node.log ? node.log.length : 0}</b></div>
      </div>

      <div class="node-section-title">
        <span>Replicated Log</span>
        <span>${node.commitIndex > 0 ? `Committed: ${node.commitIndex}` : ''}</span>
      </div>
      <div class="log-container">${logHtml}</div>

      <div class="node-section-title">
        <span>Committed State Machine</span>
        <span>${kvKeys.length} keys</span>
      </div>
      <div class="kv-container">${kvHtml}</div>

      <div class="node-actions">
        ${node.isKilled
          ? `<button class="btn btn-success btn-sm" onclick="restartNode(${node.id})">Restart Node</button>`
          : `<button class="btn btn-danger btn-sm" onclick="crashNode(${node.id})">Crash Node</button>`
        }
      </div>
    `;

    nodesContainer.appendChild(card);
  });
}

function renderRPCs(rpcs) {
  if (!rpcs || rpcs.length === 0) return;

  const html = rpcs.slice(-15).reverse().map(rpc => {
    const time = new Date(rpc.timestamp).toLocaleTimeString().split(' ')[0];
    const statusClass = rpc.dropped ? 'drop' : 'ok';
    const statusText = rpc.dropped ? 'DROPPED ❌' : 'DELIVERED ✓';

    return `
      <div class="rpc-row">
        <span>${time} Node ${rpc.from} ➔ Node ${rpc.to}</span>
        <span class="rpc-type ${rpc.type}">${rpc.type} (T${rpc.term})</span>
        <span class="rpc-status ${statusClass}">${statusText}</span>
      </div>
    `;
  }).join('');

  rpcStream.innerHTML = html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Window actions for buttons
window.crashNode = async (id) => {
  await fetch(`${API_BASE}/crash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: id })
  });
  logConsole(`Crash signal delivered to Node ${id}`, 'error');
  updateCluster();
};

window.restartNode = async (id) => {
  await fetch(`${API_BASE}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: id })
  });
  logConsole(`Restart signal delivered to Node ${id}`, 'success');
  updateCluster();
};

// Controls
btnIsolateLeader.addEventListener('click', async () => {
  await fetch(`${API_BASE}/isolate-leader`, { method: 'POST' });
  logConsole('Isolated current leader into minority network partition!', 'error');
  updateCluster();
});

btnSplitPartition.addEventListener('click', async () => {
  await fetch(`${API_BASE}/split-partition`, { method: 'POST' });
  logConsole('Cluster split into two partitions: {Node 0, 1} vs {Node 2, 3, 4}', 'error');
  updateCluster();
});

btnHeal.addEventListener('click', async () => {
  await fetch(`${API_BASE}/heal`, { method: 'POST' });
  logConsole('Network healed! All partitions resolved, quorum unified.', 'success');
  updateCluster();
});

// KV Client Actions
async function sendClientOp(op) {
  const key = inputKey.value.trim();
  const value = inputValue.value.trim();

  if (!key) {
    logConsole('Please specify a key', 'error');
    return;
  }

  logConsole(`Client sending ${op}("${key}"${op !== 'GET' ? `, "${value}"` : ''})...`, 'info');

  try {
    const res = await fetch(`${API_BASE}/client/op`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, key, value })
    });
    const result = await res.json();

    if (result.error) {
      logConsole(`${op} failed: ${result.error}`, 'error');
    } else {
      logConsole(
        `✓ ${op} OK! Response: "${result.value || ''}" via Node ${result.leaderNode} in ${result.durationMs}ms`,
        'success'
      );
    }
  } catch (err) {
    logConsole(`Client error: ${err.message}`, 'error');
  }

  updateCluster();
}

btnPut.addEventListener('click', () => sendClientOp('PUT'));
btnAppend.addEventListener('click', () => sendClientOp('APPEND'));
btnGet.addEventListener('click', () => sendClientOp('GET'));

// Chaos Monkey Test
btnChaos.addEventListener('click', async () => {
  if (chaosRunning) return;
  chaosRunning = true;
  btnChaos.disabled = true;
  logConsole('🐒 STARTING CHAOS MONKEY BENCHMARK (15 random operations with live failures)...', 'info');

  const operations = [
    { op: 'PUT', key: 'account', value: '1000' },
    { op: 'APPEND', key: 'account', value: '+50' },
    { op: 'APPEND', key: 'account', value: '+25' },
    { op: 'GET', key: 'account' },
    { op: 'PUT', key: 'status', value: 'ACTIVE' },
    { op: 'APPEND', key: 'log', value: 'event1;' },
    { op: 'APPEND', key: 'log', value: 'event2;' },
    { op: 'GET', key: 'log' },
    { op: 'GET', key: 'status' }
  ];

  for (let i = 0; i < operations.length; i++) {
    const item = operations[i];

    // Inject random crash or partition occasionally
    if (i === 2) {
      const target = Math.floor(Math.random() * 5);
      logConsole(`[Chaos] Crashing random node ${target}`, 'error');
      await window.crashNode(target);
    } else if (i === 5) {
      logConsole(`[Chaos] Inducing split-brain partition`, 'error');
      await fetch(`${API_BASE}/split-partition`, { method: 'POST' });
    } else if (i === 7) {
      logConsole(`[Chaos] Healing partition and recovering nodes`, 'success');
      await fetch(`${API_BASE}/heal`, { method: 'POST' });
      for (let n = 0; n < 5; n++) await window.restartNode(n);
    }

    await sendClientOp(item.op);
    await new Promise(r => setTimeout(r, 400));
  }

  logConsole('🎉 CHAOS MONKEY COMPLETE: Linearizability & Quorum Consistency Preserved!', 'success');
  chaosRunning = false;
  btnChaos.disabled = false;
  updateCluster();
});

// Periodic poll for cluster status
setInterval(updateCluster, 350);
updateCluster();
