'use strict';
/*
 * Linux-only performance harness (uses /proc and Xvfb). Launches the app, drives it through the DevTools
 * protocol and reports startup time, memory (PSS summed over all Electron processes), idle/typing/search CPU
 * and typing latency.
 *
 *   node tools/measure.js <appDir> <label> [runs]
 *   ELECTRON_BIN=/path/to/electron node tools/measure.js . v2 3
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const [, , appDirArg, label = 'run', runsArg] = process.argv;
const appDir = path.resolve(appDirArg || '.');
const RUNS = Number(runsArg) || 3;
const ELECTRON = process.env.ELECTRON_BIN || path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const CLK = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

function makeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'notes', 'deep'), { recursive: true });
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, i % 2 ? 'notes' : '', `doc${i}.md`), `# Doc ${i}\n\n` + 'Lorem ipsum dolor sit amet. '.repeat(80) + '\n');
  fs.writeFileSync(path.join(dir, 'notes', 'deep', 'leaf.txt'), 'needle in a haystack\n');
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'.split(' ');
  const lines = [];
  for (let i = 0; i < 15000; i++) {
    let line = '';
    for (let w = 0; w < 11; w++) line += words[(i * 7 + w * 13) % words.length] + ' ';
    lines.push(i % 1000 === 0 ? line + 'needle' : line.trim());
  }
  fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'));
}

function procs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out.push({ pid: +d, ppid: +f[1], ticks: +f[11] + +f[12] });
    } catch { /* process vanished */ }
  }
  return out;
}

function findTree(port) {
  const all = procs();
  const main = all.find((p) => {
    try {
      const c = fs.readFileSync(`/proc/${p.pid}/cmdline`, 'utf8');
      return c.includes(`remote-debugging-port=${port}`) && !c.includes('--type=') && !c.includes('xvfb-run') && c.includes('electron');
    } catch { return false; }
  });
  if (!main) return [];
  const tree = new Set([main.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; }
  }
  return [...tree];
}

function memory(port) {
  let pss = 0;
  const pids = findTree(port);
  for (const pid of pids) {
    try {
      const m = /Pss:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (m) pss += +m[1];
    } catch { /* ignore */ }
  }
  return { pssMB: +(pss / 1024).toFixed(1), procs: pids.length };
}

function ticks(port) {
  const set = new Set(findTree(port));
  return procs().filter((p) => set.has(p.pid)).reduce((s, p) => s + p.ticks, 0);
}

async function cpuOver(port, ms) {
  const a = ticks(port);
  const t = Date.now();
  await sleep(ms);
  return +(((ticks(port) - a) / CLK / ((Date.now() - t) / 1000)) * 100).toFixed(1);
}

const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const log = (...a) => { if (process.env.MEASURE_DEBUG) console.error(new Date().toISOString().slice(17, 23), ...a); };

async function oneRun(n) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'np-perf-'));
  const wsDir = path.join(base, 'ws');
  const ud = path.join(base, 'ud');
  fs.mkdirSync(wsDir); fs.mkdirSync(ud);
  makeWorkspace(wsDir);
  fs.writeFileSync(path.join(ud, 'preferences.json'), JSON.stringify({ lastWorkspace: wsDir }));
  const port = 9400 + n;
  const t0 = Date.now();
  const child = spawn('xvfb-run', ['-a', ELECTRON, appDir, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${ud}`], { detached: true, stdio: 'ignore' });
  child.unref();

  let page;
  for (let i = 0; i < 1600 && !page; i++) {
    try { page = (await getJson(`http://127.0.0.1:${port}/json`)).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    if (!page) await sleep(25);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;

  let startup = null;
  for (let i = 0; i < 600; i++) {
    if (await ev(`document.querySelectorAll('.tree-row').length > 0`)) { startup = Date.now() - t0; break; }
    await sleep(25);
  }
  log('startup', startup);
  const R = { startupMs: startup };
  await sleep(3000);
  log('idle mem');
  R.idle = memory(port);
  log('idle cpu');
  R.idleCpu = await cpuOver(port, 8000);

  for (const f of ['notes/doc1.md', 'doc2.md', 'notes/doc3.md', 'doc4.md', 'notes/doc5.md']) {
    await ev(`NP.editor.openFile(${JSON.stringify(path.join(wsDir, f))}).then(() => 1)`);
  }
  log('tabs opened');
  await sleep(2500);
  R.tabs5 = memory(port);

  await ev(`NP.editor.openFile(${JSON.stringify(path.join(wsDir, 'big.txt'))}).then(() => 1)`);
  await sleep(3500);
  R.bigDoc = memory(port);
  log('big opened');
  R.bigDocHeapMB = +((await send('Runtime.getHeapUsage')).result.usedSize / 1048576).toFixed(1);

  await ev(`(()=>{const t=NP.editor.activeDoc().el; t.focus(); const p=Math.floor(t.value.length/2); t.setSelectionRange(p,p);})()`);
  log('typing start');
  const lat = [];
  const a = ticks(port);
  const tt = Date.now();
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    await send('Input.insertText', { text: 'x' });
    lat.push(performance.now() - s);
    await sleep(20);
  }
  R.typingCpu = +(((ticks(port) - a) / CLK / ((Date.now() - tt) / 1000)) * 100).toFixed(1);
  R.typingLatMedianMs = +median(lat).toFixed(1);
  R.typingLatP95Ms = +pct(lat, 0.95).toFixed(1);
  await sleep(1500);

  log('typing done');
  await ev(`NP.find.open()`);
  const sc = ticks(port);
  const st = Date.now();
  await ev(`(()=>{const i=document.getElementById('find-input'); i.value='needle'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(1500);
  R.searchCpuWindow = +(((ticks(port) - sc) / CLK / ((Date.now() - st) / 1000)) * 100).toFixed(1);
  log('search typed');
  R.findStepMs = await ev(`(()=>{const i=document.getElementById('find-input'); const s=performance.now(); for(let k=0;k<20;k++) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return +((performance.now()-s)/20).toFixed(2);})()`);
  await sleep(1500);
  R.afterEdit = memory(port);

  try { execSync(`pkill -f "remote-debugging-port=${port}"`); } catch { /* already gone */ }
  ws.close();
  await sleep(800);
  fs.rmSync(base, { recursive: true, force: true });
  return R;
}

(async () => {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await oneRun(i));
  const pick = (fn) => median(runs.map(fn));
  const summary = {
    label, runs: RUNS,
    startupMs: pick((r) => r.startupMs),
    idleMemMB: pick((r) => r.idle.pssMB), processes: pick((r) => r.idle.procs),
    idleCpuPct: pick((r) => r.idleCpu),
    tabs5MemMB: pick((r) => r.tabs5.pssMB),
    bigDocMemMB: pick((r) => r.bigDoc.pssMB), bigDocHeapMB: pick((r) => r.bigDocHeapMB),
    afterEditMemMB: pick((r) => r.afterEdit.pssMB),
    typingCpuPct: pick((r) => r.typingCpu),
    typingLatMedianMs: pick((r) => r.typingLatMedianMs), typingLatP95Ms: pick((r) => r.typingLatP95Ms),
    searchCpuPct: pick((r) => r.searchCpuWindow), findStepMs: pick((r) => r.findStepMs)
  };
  console.log(JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(os.tmpdir(), `perf-${label}.json`), JSON.stringify({ summary, runs }, null, 1));
})().catch((e) => { console.error('measure failed', e); process.exit(1); });
