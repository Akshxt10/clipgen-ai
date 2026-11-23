/* ClipGen AI backend · entry point: `node src/index.js` */
import { loadConfig } from './config.js';
import { createApp, createServer } from './server.js';

const cfg = loadConfig();
const app = await createApp(cfg);
const server = createServer(app);

const sweep = () => app.store.sweep().then((n) => { if (n && cfg.log !== 'silent') console.log('[cleanup] removed', n, 'expired project(s)'); }).catch((e) => console.error('[cleanup]', e.message));
setInterval(sweep, 10 * 60 * 1000).unref();
sweep();

server.listen(cfg.port, cfg.host, () => {
  const tr = app.transcriber.available();
  console.log('ClipGen AI backend ' + cfg.version + ' listening on ' + cfg.host + ':' + cfg.port);
  console.log('  data dir      : ' + cfg.dataDir);
  console.log('  allowed origin: ' + cfg.allowedOrigins.join(', '));
  console.log('  access token  : ' + (cfg.accessToken ? 'required' : 'NOT SET (anyone who knows the address can use this server)'));
  console.log('  transcription : ' + (tr.ok ? 'whisper.cpp · ' + tr.model : 'unavailable — ' + tr.reason));
  if (cfg.allowPrivateUrls) console.log('  WARNING: ALLOW_PRIVATE_URLS=1 (test mode) — never use this on a public server');
});

const stop = () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
