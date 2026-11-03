import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('../..', import.meta.url)), 'site-dist');
const port = Number(process.env['PORT'] ?? 4174);

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const OK = 200;
const NOT_FOUND = 404;

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, relative.endsWith('/') ? `${relative}index.html` : relative);

  readFile(file).then(
    (bytes) => {
      const headers: Record<string, string> = {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      };
      response.writeHead(OK, headers);
      response.end(bytes);
    },
    () => {
      response.writeHead(NOT_FOUND);
      response.end();
    },
  );
}).listen(port);
