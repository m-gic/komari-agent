#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const os = require('os');

const {
  AGENT_TOKEN = '',
  AGENT_ENDPOINT = '',
  FILE_PATH = path.join(__dirname, '.npm'),
  PORT = 3000
} = process.env;

if (!AGENT_TOKEN || !AGENT_ENDPOINT) {
  console.error('Missing AGENT_TOKEN or AGENT_ENDPOINT');
  process.exit(1);
}

// ==================== 下载工具（支持重定向） ====================
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, { headers: { 'User-Agent': 'node.js' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(new URL(res.headers.location, url).href, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
      else res.pipe(fs.createWriteStream(dest)).on('finish', resolve).on('error', reject);
    }).on('error', reject);
  });
}

// ==================== 主流程 ====================
const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'arm' };
const arch = archMap[os.arch()] || 'amd64';
const platform = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'darwin' : 'linux';
const binName = `komari-agent-${platform}-${arch}`;
const binPath = path.join(FILE_PATH, 'agent');

fs.mkdirSync(FILE_PATH, { recursive: true });

const url = `https://github.com/komari-monitor/komari-agent/releases/latest/download/${binName}`;

(async () => {
  if (!fs.existsSync(binPath)) {
    console.log(`⬇️  Downloading ${url}`);
    await downloadFile(url, binPath);
    fs.chmodSync(binPath, 0o755);
    console.log(`✅ Binary downloaded to ${binPath}`);
  } else {
    console.log(`✅ Using existing binary at ${binPath}`);
  }

  const child = spawn(binPath, ['--token', AGENT_TOKEN, '--endpoint', AGENT_ENDPOINT], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  console.log(`🚀 Agent started with PID: ${child.pid}`);

  // HTTP 保活服务
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('komari-agent running\n');
  }).listen(PORT, () => {
    console.log(`📡 HTTP keep-alive server on port ${PORT}`);
  });
})();
