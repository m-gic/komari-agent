#!/usr/bin/env node
const os = require('os'), fs = require('fs'), path = require('path');
const { spawnSync, execSync } = require('child_process');
const https = require('https'), http = require('http');

// ===== 用户配置（可直接修改）=====
const TOKEN = process.env.AGENT_TOKEN || '';      // 填写 token
const ENDPOINT = process.env.AGENT_ENDPOINT || ''; // 填写 endpoint
// =================================

const C = { r: '\x1b[0;31m', g: '\x1b[0;32m', y: '\x1b[0;33m', b: '\x1b[0;34m', c: '\x1b[0;36m', w: '\x1b[1;37m', n: '\x1b[0m' };
const log = (m, c = '') => console.log(c + m + C.n);
const ok = m => log('✓ ' + m, C.g);
const err = m => { log('[ERROR] ' + m, C.r); process.exit(1); };

const home = os.homedir();
const plat = os.platform();
const arch = os.arch() === 'x64' ? 'amd64' : os.arch() === 'arm64' ? 'arm64' : '386';
const osName = plat === 'darwin' ? 'darwin' : plat === 'win32' ? 'windows' : 'linux';
const defaultDir = plat === 'darwin' ? path.join(home, '.komari') :
                   plat === 'win32' ? path.join(home, 'AppData', 'Local', 'komari') :
                   path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'komari');

let targetDir = defaultDir, serviceName = 'komari-agent', ghProxy = '', version = 'latest';
let args = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--install-dir') targetDir = argv[++i];
  else if (argv[i] === '--install-service-name') serviceName = argv[++i];
  else if (argv[i] === '--install-ghproxy') ghProxy = argv[++i];
  else if (argv[i] === '--install-version') version = argv[++i];
  else args.push(argv[i]);
}
if (TOKEN) args.push('--token', TOKEN);
if (ENDPOINT) args.push('--endpoint', ENDPOINT);

const agentPath = path.join(targetDir, 'agent');

// 检测 init 系统
const detectInit = () => {
  if (plat === 'darwin') return 'launchd';
  try { if (spawnSync('systemctl', ['--user', 'show-environment']).status === 0) return 'systemd-user'; } catch (_) {}
  return 'unknown';
};
const init = detectInit();

log('=== Komari Agent Installer ===', C.w);
log(`OS: ${osName} ${arch}  Init: ${init}`);
log(`Install dir: ${targetDir}`);
log(`Args: ${args.join(' ') || '(none)'}`);

// 检查 curl
if (spawnSync('curl', ['--version']).error) err('curl required');

// 卸载旧服务
const stopService = () => {
  if (init === 'systemd-user') {
    spawnSync('systemctl', ['--user', 'stop', serviceName + '.service']);
    spawnSync('systemctl', ['--user', 'disable', serviceName + '.service']);
    const f = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', serviceName + '.service');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  } else if (init === 'launchd') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `com.komari.${serviceName}.plist`);
    spawnSync('launchctl', ['bootout', `gui/${execSync('id -u').toString().trim()}`, plist]);
    if (fs.existsSync(plist)) fs.unlinkSync(plist);
  }
};
stopService();
if (fs.existsSync(agentPath)) fs.unlinkSync(agentPath);

// 下载二进制
const download = (url, dest) => new Promise((res, rej) => {
  const proto = url.startsWith('https') ? https : http;
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = fs.createWriteStream(dest);
  proto.get(url, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      file.close();
      download(r.headers.location, dest).then(res).catch(rej);
      return;
    }
    if (r.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); rej(new Error('status ' + r.statusCode)); return; }
    r.pipe(file);
  }).on('error', rej);
  file.on('finish', () => { file.close(); res(); });
});

const fileName = `komari-agent-${osName}-${arch}`;
const verPath = version === 'latest' ? 'latest/download' : `download/${version}`;
let url = `https://github.com/komari-monitor/komari-agent/releases/${verPath}/${fileName}`;
if (ghProxy) url = `${ghProxy}/${url}`;
log('Downloading: ' + url, C.c);
download(url, agentPath).then(() => {
  fs.chmodSync(agentPath, 0o755);
  ok('Binary ready');
  // 安装服务
  if (init === 'systemd-user') {
    const svcDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user');
    if (!fs.existsSync(svcDir)) fs.mkdirSync(svcDir, { recursive: true });
    const content = `[Unit]\nDescription=Komari Agent\nAfter=network.target\n\n[Service]\nExecStart=${agentPath} ${args.join(' ')}\nWorkingDirectory=${targetDir}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
    fs.writeFileSync(path.join(svcDir, serviceName + '.service'), content);
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    spawnSync('systemctl', ['--user', 'enable', '--now', serviceName + '.service']);
    ok('Systemd user service started');
  } else if (init === 'launchd') {
    const agents = path.join(home, 'Library', 'LaunchAgents');
    if (!fs.existsSync(agents)) fs.mkdirSync(agents, { recursive: true });
    const plist = path.join(agents, `com.komari.${serviceName}.plist`);
    const argsXml = args.map(a => `        <string>${a}</string>`).join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n    <key>Label</key>\n    <string>com.komari.${serviceName}</string>\n    <key>ProgramArguments</key>\n    <array>\n        <string>${agentPath}</string>\n${argsXml}\n    </array>\n    <key>WorkingDirectory</key>\n    <string>${targetDir}</string>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n</dict>\n</plist>\n`;
    fs.writeFileSync(plist, content);
    const uid = execSync('id -u').toString().trim();
    spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    ok('launchd service started');
  } else {
    log('No service installed; binary at ' + agentPath);
  }
  log('=== Done ===', C.w);
  ok('Agent installed');
}).catch(err);
