'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const packagePath = path.resolve(process.argv[2] || '');
const port = Number(process.env.COCKPIT_WINVOICE_INSTALLER_PORT || 18080);

if (!packagePath || !fs.statSync(packagePath).isFile()) {
  throw new Error('informe o caminho do ChatGPT-x64.msix');
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  if (request.method !== 'GET' || request.url !== '/ChatGPT-x64.msix') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }

  const stat = fs.statSync(packagePath);
  response.writeHead(200, {
    'Content-Type': 'application/msix',
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(packagePath).pipe(response);
});

server.listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
