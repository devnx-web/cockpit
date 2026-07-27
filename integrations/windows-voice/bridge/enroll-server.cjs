'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const listenHost = '127.0.0.1';
const listenPort = Number(process.env.COCKPIT_BRIDGE_ENROLL_PORT || 18081);
const token = process.env.COCKPIT_BRIDGE_ENROLL_TOKEN || '';
const authorizedKeysPath = process.env.COCKPIT_BRIDGE_AUTHORIZED_KEYS || '';
const forcedCommand = process.env.COCKPIT_BRIDGE_FORCED_COMMAND || '';
const bootstrapDir = process.env.COCKPIT_BRIDGE_BOOTSTRAP_DIR || '';
const timeoutMs = Number(process.env.COCKPIT_BRIDGE_ENROLL_TIMEOUT_MS || 600000);

if (!/^[\x21-\x7e]{32,256}$/.test(token)) {
  throw new Error('token de matrícula ausente ou inválido');
}
if (!path.isAbsolute(authorizedKeysPath) || !path.isAbsolute(forcedCommand)) {
  throw new Error('caminhos absolutos da ponte são obrigatórios');
}
if (!path.isAbsolute(bootstrapDir)) {
  throw new Error('diretório absoluto de bootstrap é obrigatório');
}
if (!/^[a-zA-Z0-9_./-]+$/.test(forcedCommand)) {
  throw new Error('caminho do forced-command contém caracteres inválidos');
}
if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
  throw new Error('porta de matrícula inválida');
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 3600000) {
  throw new Error('timeout de matrícula inválido');
}

function timingSafeToken(candidate) {
  const expected = Buffer.from(token);
  const received = Buffer.from(candidate || '');
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

function normalizeEd25519PublicKey(value, expectedComment) {
  if (typeof value !== 'string' || value.length > 1024) {
    throw new Error('chave pública ausente ou grande demais');
  }
  const match = value
    .trim()
    .match(/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,120})?$/);
  if (!match) throw new Error('somente chaves ssh-ed25519 são aceitas');

  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.length < 48 || decoded.length > 80) {
    throw new Error('chave ssh-ed25519 malformada');
  }
  return `ssh-ed25519 ${match[1]} ${expectedComment}`;
}

function installKeys(mcpPublicKey, devPublicKey) {
  const mcp = normalizeEd25519PublicKey(
    mcpPublicKey,
    'cockpit-windows-voice-mcp',
  );
  const dev = normalizeEd25519PublicKey(
    devPublicKey,
    'cockpit-windows-voice-dev',
  );
  if (mcp.split(' ')[1] === dev.split(' ')[1]) {
    throw new Error('MCP e desenvolvimento exigem chaves diferentes');
  }

  const lines = [
    `restrict,port-forwarding,permitopen="127.0.0.1:3740",command="${forcedCommand}" ${mcp}`,
    `restrict,pty ${dev}`,
    '',
  ];
  const parent = path.dirname(authorizedKeysPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    parent,
    `.authorized_keys.${process.pid}.tmp`,
  );
  fs.writeFileSync(temporaryPath, lines.join('\n'), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporaryPath, authorizedKeysPath);
  fs.chmodSync(authorizedKeysPath, 0o600);
}

let completed = false;
const bootstrapFiles = new Map([
  ['setup-windows.ps1', 'text/plain; charset=utf-8'],
  ['start-mcp-tunnel.ps1', 'text/plain; charset=utf-8'],
  ['bridge-info.json', 'application/json; charset=utf-8'],
  ['cockpit-linux-known_hosts', 'text/plain; charset=utf-8'],
]);

function bootstrapRunner() {
  const quotedToken = JSON.stringify(token);
  return [
    '$ErrorActionPreference = "Stop"',
    'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force',
    `$t = ${quotedToken}`,
    '$d = Join-Path $env:TEMP "cockpit-bridge"',
    'New-Item -ItemType Directory -Force $d | Out-Null',
    '$headers = @{ Authorization = "Bearer $t" }',
    '$files = @("setup-windows.ps1", "start-mcp-tunnel.ps1", "bridge-info.json", "cockpit-linux-known_hosts")',
    'foreach ($file in $files) {',
    `  Invoke-WebRequest -UseBasicParsing -Headers $headers "http://10.0.2.2:${listenPort}/bootstrap/$file" -OutFile (Join-Path $d $file)`,
    '}',
    '& (Join-Path $d "setup-windows.ps1") -EnrollmentToken $t',
    '',
  ].join('\r\n');
}

const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ready');
    return;
  }

  const authorization = request.headers.authorization || '';
  const suppliedToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const authenticated = timingSafeToken(suppliedToken);

  if (request.method === 'GET' && request.url.startsWith('/run/')) {
    const suppliedPathToken = request.url.slice('/run/'.length);
    if (!timingSafeToken(suppliedPathToken)) {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('not found');
      return;
    }
    const runner = bootstrapRunner();
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(runner)),
    });
    response.end(runner);
    return;
  }

  if (
    request.method === 'GET' &&
    request.url.startsWith('/bootstrap/') &&
    authenticated
  ) {
    const fileName = request.url.slice('/bootstrap/'.length);
    const contentType = bootstrapFiles.get(fileName);
    if (!contentType) {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('not found');
      return;
    }
    const filePath = path.join(bootstrapDir, fileName);
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('not found');
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
    });
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  if (
    request.method !== 'POST' ||
    request.url !== '/enroll' ||
    !authenticated
  ) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }

  let size = 0;
  const chunks = [];
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > 8192) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (size > 8192 || completed) {
      response.writeHead(409, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      installKeys(body.mcpPublicKey, body.devPublicKey);
      completed = true;
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ ok: true }));
      process.stderr.write(
        '[windows-voice] duas chaves públicas matriculadas; servidor encerrado.\n',
      );
      setImmediate(() => server.close());
    } catch {
      response.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ ok: false }));
    }
  });
});

server.listen(listenPort, listenHost, () => {
  process.stderr.write(
    `[windows-voice] matrícula aguardando no loopback por ${Math.round(
      timeoutMs / 1000,
    )} segundos.\n`,
  );
});

const timer = setTimeout(() => {
  process.stderr.write('[windows-voice] matrícula expirou sem alterações.\n');
  server.close();
}, timeoutMs);
timer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
