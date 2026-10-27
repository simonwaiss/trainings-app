import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';

// Kleiner Webserver wie GitHub Pages (Pfad /trainings-app/), dessen Ordner sich umschalten lässt:
// so lässt sich ein Update von Version 1 auf Version 2 nachstellen.
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

export class StaticServer {
  root: string;
  private server: Server;
  port = 0;

  constructor(root: string) {
    this.root = root;
    this.server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/trainings-app/, '') || '/';
      let file = join(this.root, path);
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(this.root, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      createReadStream(file).pipe(res);
    });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
    return `http://127.0.0.1:${this.port}/trainings-app/`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}
