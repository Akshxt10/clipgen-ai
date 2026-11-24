/* Tests for the Oracle deployment scripts (no Docker/Oracle needed: bootstrap.sh has a dry-run mode). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '..');
const dir = path.join(backend, 'deploy', 'oracle');
const bootstrap = path.join(dir, 'bootstrap.sh');
const wrapper = path.join(dir, 'user-data.template.sh');
const read = (p) => fs.readFileSync(p, 'utf8');

const TOKEN = 'Zq7-Kd3-Lm9-Xw2-Pa5-Tr8';        // fake, test only
const DDNS = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'; // fake, test only
const GOOD_HW = { HW_SHAPE: 'VM.Standard.A1.Flex', HW_ARCH: 'aarch64', HW_CPUS: '2', HW_MEM_MB: '11900', HW_DISK_GB: '96' };

function dry(extra = {}, root) {
  root = root || fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deploy-'));
  const env = { PATH: process.env.PATH, HOME: root, CLIPGEN_DRYRUN: '1', CLIPGEN_ROOT: root, DOMAIN: 'aksh-clipgen.duckdns.org', ACCESS_TOKEN: TOKEN, ...GOOD_HW, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('bash', [bootstrap], { env, encoding: 'utf8' });
  return { root, status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

test('scripts have valid bash syntax', () => {
  for (const f of [bootstrap, wrapper]) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + ': ' + r.stderr);
  }
});

test('the cloud-init wrapper pins the exact checksum of bootstrap.sh and contains no real secrets', () => {
  const sum = crypto.createHash('sha256').update(fs.readFileSync(bootstrap)).digest('hex');
  const w = read(wrapper);
  assert.ok(w.includes('BOOTSTRAP_SHA256="' + sum + '"'),
    'bootstrap.sh changed: update BOOTSTRAP_SHA256 in user-data.template.sh to ' + sum + ' (sha256sum backend/deploy/oracle/bootstrap.sh)');
  assert.match(w, /ACCESS_TOKEN="REPLACE_WITH_/);
  assert.match(w, /DOMAIN="REPLACE_WITH_/);
  assert.match(w, /DUCKDNS_TOKEN=""/);
  assert.doesNotMatch(w, /ACCESS_TOKEN="(?!REPLACE_WITH_)[^"]+"/);
  assert.match(w, /sha256sum -c/);
});

test('no file in the deploy folder, Dockerfile or docs contains a token-like secret', () => {
  const files = [bootstrap, wrapper, path.join(backend, 'Dockerfile'), path.join(backend, 'DEPLOY.md')];
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, f + ' contains a UUID-like (DuckDNS-token-like) value');
    assert.doesNotMatch(t, /(ACCESS_TOKEN|SIGNING_SECRET|DUCKDNS_TOKEN)=['"]?(?!REPLACE_WITH_)[A-Za-z0-9._~-]{20,}/, f + ' contains a filled-in secret');
  }
});

test('valid settings: dry run writes root-only config, Caddyfile proxies only to the private backend', () => {
  const { root, status, out } = dry({ ACME_EMAIL: 'me@example.com', DUCKDNS_TOKEN: DDNS });
  assert.equal(status, 0, out);
  const etc = path.join(root, 'etc/clipgen');
  for (const f of ['config.env', 'app.env', 'duckdns.env', 'Caddyfile']) assert.equal(mode(path.join(etc, f)), '600', f + ' must be root-only');
  const app = read(path.join(etc, 'app.env'));
  assert.match(app, /^ACCESS_TOKEN=Zq7-Kd3-Lm9-Xw2-Pa5-Tr8$/m);
  assert.match(app, /^SIGNING_SECRET=[0-9a-f]{64}$/m);
  assert.match(app, /^ALLOWED_ORIGINS=https:\/\/akshxt10\.github\.io,https:\/\/aksh-clipgen\.duckdns\.org$/m);
  assert.match(app, /^TRUST_PROXY=1$/m);
  assert.match(app, /^MAX_DURATION_MIN=45$/m);
  assert.match(app, /^MAX_DISK_MB=44236$/m); // 45% of a 96 GB disk
  const cad = read(path.join(etc, 'Caddyfile'));
  assert.match(cad, /^aksh-clipgen\.duckdns\.org \{/m);
  assert.match(cad, /reverse_proxy clipgen-app:7860/);
  assert.match(cad, /admin off/);
  assert.match(cad, /email me@example\.com/);
  assert.doesNotMatch(cad, /\blog\b/, 'no access log: signed URLs carry a signature');
  assert.equal(read(path.join(etc, 'duckdns.env')).includes('DUCKDNS_DOMAIN=aksh-clipgen\n'), true);
  // the config that is not secret must not contain secrets
  const conf = read(path.join(etc, 'config.env'));
  assert.ok(!conf.includes(TOKEN) && !conf.includes(DDNS));
});

test('secrets never reach the log or the console output', () => {
  const { root, out } = dry({ DUCKDNS_TOKEN: DDNS });
  const log = read(path.join(root, 'var/log/clipgen-setup.log'));
  for (const s of [TOKEN, DDNS]) { assert.ok(!out.includes(s), 'console output leaked a secret'); assert.ok(!log.includes(s), 'log leaked a secret'); }
  assert.equal(mode(path.join(root, 'var/log/clipgen-setup.log')), '600');
  // a rejected token is not echoed either
  const bad = dry({ ACCESS_TOKEN: 'short" ; rm -rf /' });
  assert.equal(bad.status, 2);
  assert.ok(!bad.out.includes('rm -rf'));
});

test('invalid inputs are rejected before anything is written', () => {
  const cases = [
    [{ DOMAIN: undefined }, /DOMAIN is missing/],
    [{ DOMAIN: 'not a domain' }, /not a valid host name/],
    [{ DOMAIN: 'bad.duckdns.org\nevil {' }, /not a valid host name/],
    [{ DOMAIN: '203.0.113.7' }, /(not a valid host name|not an IP)/],
    [{ ACCESS_TOKEN: undefined }, /ACCESS_TOKEN is missing/],
    [{ ACCESS_TOKEN: 'tooShort-123' }, /ACCESS_TOKEN must be/],
    [{ ACCESS_TOKEN: 'has spaces and quotes " inside 12345' }, /ACCESS_TOKEN must be/],
    [{ ACCESS_TOKEN: 'abcdefghijklmnopqrstuvwxyz\nINJECT=1' }, /ACCESS_TOKEN must be/],
    [{ ACME_EMAIL: 'nope' }, /ACME_EMAIL/],
    [{ DUCKDNS_TOKEN: 'zzzz' }, /DUCKDNS_TOKEN/],
    [{ DOMAIN: 'x.example.com', DUCKDNS_TOKEN: DDNS }, /duckdns\.org/],
    [{ WHISPER_MODEL: 'large' }, /WHISPER_MODEL/],
    [{ ALLOWED_ORIGINS: 'https://a.example; drop' }, /ALLOWED_ORIGINS/],
    [{ MAX_DURATION_MIN: 'abc' }, /MAX_DURATION_MIN/],
    [{ REPO_REF: 'main; rm -rf /' }, /REPO_REF/]
  ];
  for (const [env, re] of cases) {
    const r = dry(env);
    assert.equal(r.status, 2, JSON.stringify(Object.keys(env)) + ' should be rejected: ' + r.out);
    assert.match(r.out, re);
    assert.ok(!fs.existsSync(path.join(r.root, 'etc/clipgen/app.env')), 'nothing may be written on invalid input');
  }
});

test('free-tier guard refuses machines that could cost money, and the override is explicit', () => {
  const cases = [
    [{ HW_CPUS: '4', HW_MEM_MB: '23000' }, /Always Free allowance/],
    [{ HW_MEM_MB: '24000' }, /12 GB/],
    [{ HW_SHAPE: 'VM.Standard.E4.Flex', HW_ARCH: 'x86_64' }, /not an Ampere A1 Flex/],
    [{ HW_SHAPE: 'VM.Standard.E2.1.Micro', HW_ARCH: 'x86_64', HW_CPUS: '1', HW_MEM_MB: '950' }, /not an Ampere A1 Flex/],
    [{ HW_SHAPE: '' }, /not an Oracle Cloud VM|not an Ampere/],
    [{ HW_DISK_GB: '250' }, /200 GB/],
    [{ HW_MEM_MB: '2000' }, /about 4 GB/]
  ];
  for (const [env, re] of cases) {
    const r = dry(env);
    assert.equal(r.status, 3, JSON.stringify(env) + ' should be refused: ' + r.out);
    assert.match(r.out, re);
    assert.match(r.out, /nothing was installed/);
    assert.ok(!fs.existsSync(path.join(r.root, 'etc/clipgen/app.env')));
  }
  const forced = dry({ HW_CPUS: '4', ALLOW_NON_FREE_SHAPE: '1' });
  assert.equal(forced.status, 0, forced.out);
  assert.match(forced.out, /free-tier guard overridden/);
  assert.equal(dry({}).status, 0);
});

test('re-running is safe: secrets are kept, saved settings are reused, nothing is duplicated', () => {
  const first = dry({ DUCKDNS_TOKEN: DDNS, ACME_EMAIL: 'me@example.com' });
  assert.equal(first.status, 0, first.out);
  const app1 = read(path.join(first.root, 'etc/clipgen/app.env'));
  // second run with NO secrets in the environment: everything is taken from the saved root-only files
  const second = dry({ DOMAIN: undefined, ACCESS_TOKEN: undefined }, first.root);
  assert.equal(second.status, 0, second.out);
  assert.equal(read(path.join(first.root, 'etc/clipgen/app.env')), app1, 'SIGNING_SECRET/ACCESS_TOKEN must be stable across re-runs');
  assert.match(read(path.join(first.root, 'etc/clipgen/Caddyfile')), /email me@example\.com/);
  const third = dry({}, first.root);
  assert.equal(third.status, 0);
  assert.equal(read(path.join(first.root, 'etc/clipgen/app.env')), app1);
  // changing the token is possible and keeps the signing secret
  const rotated = dry({ ACCESS_TOKEN: 'Rt4-Yu6-Io8-Pl2-Mn5-Bv1' }, first.root);
  assert.equal(rotated.status, 0);
  const app2 = read(path.join(first.root, 'etc/clipgen/app.env'));
  assert.match(app2, /^ACCESS_TOKEN=Rt4-Yu6-Io8-Pl2-Mn5-Bv1$/m);
  assert.equal(app2.match(/SIGNING_SECRET=.*/)[0], app1.match(/SIGNING_SECRET=.*/)[0]);
});

test('script structure: only Caddy publishes ports, restart policy and log limits on both containers, no paid-upgrade or Oracle API calls', () => {
  const t = read(bootstrap);
  const runs = t.split(/\n(?=\s*docker run)/).filter((s) => /^\s*docker run/.test(s));
  assert.equal(runs.length, 2);
  const app = runs.find((s) => s.includes('--name clipgen-app'));
  const caddy = runs.find((s) => s.includes('--name clipgen-caddy'));
  assert.ok(app && caddy);
  const head = (s) => s.split('>/dev/null')[0];
  assert.doesNotMatch(head(app), /(^|\s)(-p|--publish|-P)(\s|=)/, 'backend container must not publish ports');
  assert.doesNotMatch(head(app), /7860:/);
  assert.match(head(caddy), /-p 80:80 -p 443:443/);
  assert.doesNotMatch(head(caddy), /7860/);
  for (const c of [app, caddy]) { assert.match(head(c), /--restart unless-stopped/); assert.match(head(c), /--cap-drop ALL/); assert.match(head(c), /no-new-privileges/); assert.match(head(c), /LOGOPTS/); }
  assert.match(t, /LOGOPTS=\(--log-driver json-file --log-opt max-size=10m --log-opt max-file=3\)/);
  assert.match(t, /--env-file "\$APPENV"/, 'secrets go through an env-file, not the command line');
  assert.doesNotMatch(t, /\boci\b\s+(compute|iam|network|bv|budgets)/i, 'must not call the Oracle CLI');
  assert.doesNotMatch(t, /(upgrade-to-payg|pay[- ]as[- ]you[- ]go)\s*[:=(]/i);
  assert.doesNotMatch(t, /set -x|bash -x/);
  assert.match(t, /169\.254\.169\.254 -j DROP/);
  assert.doesNotMatch(t, /--dport 7860/);
});

test('Dockerfile: portable whisper build for ARM and a health check', () => {
  const d = read(path.join(backend, 'Dockerfile'));
  assert.match(d, /ARG WHISPER_NATIVE=OFF/);
  assert.match(d, /-DGGML_NATIVE=\$\{WHISPER_NATIVE\}/);
  assert.match(d, /HEALTHCHECK/);
});

test('DEPLOY.md no longer recommends a Hugging Face Docker Space as free', () => {
  const t = read(path.join(backend, 'DEPLOY.md'));
  assert.doesNotMatch(t, /Option A — Hugging Face Space \(free/i);
  assert.match(t, /Oracle/);
  assert.match(t, /Hugging Face/);
  assert.match(t, /paid/i);
});

test('full (non-dry) run with stubbed docker/systemctl/apt/git: correct commands, files and secrecy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-full-'));
  const bin = path.join(root, 'stubs'); fs.mkdirSync(bin);
  const calls = path.join(root, 'calls.log');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); };
  stub('docker', 'echo "docker $*" >> "' + calls + '"\ncase "$1 $2" in "network inspect"|"volume inspect") exit 1;; esac\nexit 0');
  for (const n of ['apt-get', 'systemctl', 'iptables', 'sleep']) stub(n, 'echo "' + n + ' $*" >> "' + calls + '"; exit 0');
  stub('git', 'echo "git $*" >> "' + calls + '"\nif [ "$1" = clone ]; then for a; do d="$a"; done; mkdir -p "$d/.git"; fi\nexit 0');
  stub('curl', 'echo "curl" >> "' + calls + '"; exit 0');
  stub('ss', 'exit 0');
  const env = { PATH: bin + ':' + process.env.PATH, HOME: root, CLIPGEN_ROOT: root, DOMAIN: 'aksh-clipgen.duckdns.org', ACCESS_TOKEN: TOKEN, DUCKDNS_TOKEN: DDNS, ...GOOD_HW };
  const run = () => spawnSync('bash', [bootstrap], { env, encoding: 'utf8' });
  if (process.getuid && process.getuid() !== 0) return; // the script insists on root
  const r1 = run();
  const out1 = r1.stdout + r1.stderr;
  assert.equal(r1.status, 0, out1);
  const log = read(calls);
  assert.match(log, /docker build -f backend\/Dockerfile --build-arg SOURCE=local --build-arg WHISPER_MODEL=base -t clipgen-backend:local \./);
  const appRun = log.split('\n').find((l) => l.startsWith('docker run') && l.includes('--name clipgen-app'));
  const caddyRun = log.split('\n').find((l) => l.startsWith('docker run') && l.includes('--name clipgen-caddy'));
  assert.ok(appRun && caddyRun, log);
  assert.ok(!/ -p | --publish/.test(appRun), 'backend must not publish ports: ' + appRun);
  assert.match(appRun, /--restart unless-stopped/); assert.match(appRun, /--log-opt max-size=10m --log-opt max-file=3/);
  assert.match(appRun, /--env-file \S+\/etc\/clipgen\/app\.env/);
  assert.ok(!appRun.includes(TOKEN) && !caddyRun.includes(TOKEN) && !log.includes(TOKEN) && !log.includes(DDNS), 'secrets must never be on any command line');
  assert.match(caddyRun, /-p 80:80 -p 443:443/); assert.ok(!caddyRun.includes('7860'));
  assert.match(caddyRun, /--restart unless-stopped/); assert.match(caddyRun, /--log-opt max-size=10m/);
  const fw = read(path.join(root, 'opt/clipgen/firewall.sh'));
  assert.match(fw, /--dport "\$p" -j ACCEPT/); assert.ok(!/--dport 7860|-p 7860/.test(fw));
  assert.match(fw, /DOCKER-USER[^\n]*169\.254\.169\.254 -j DROP/);
  assert.equal(mode(path.join(root, 'opt/clipgen/firewall.sh')), '700');
  assert.match(read(path.join(root, 'etc/systemd/system/clipgen-firewall.service')), /After=docker\.service/);
  assert.match(read(path.join(root, 'etc/systemd/system/clipgen-duckdns.timer')), /OnUnitActiveSec=10min/);
  const dd = read(path.join(root, 'usr/local/sbin/clipgen-duckdns'));
  assert.match(dd, /curl .* -K -/); assert.ok(!dd.includes(DDNS));
  assert.equal(mode(path.join(root, 'usr/local/sbin/clipgen-setup')), '700');
  const logfile = read(path.join(root, 'var/log/clipgen-setup.log'));
  assert.ok(!logfile.includes(TOKEN) && !logfile.includes(DDNS) && !out1.includes(TOKEN) && !out1.includes(DDNS));
  assert.match(logfile, /port 7860 is not exposed on the host: good/);
  // re-run: containers are replaced (not duplicated), source is updated not re-cloned, secrets unchanged
  const app1 = read(path.join(root, 'etc/clipgen/app.env'));
  const r2 = run();
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(read(path.join(root, 'etc/clipgen/app.env')), app1);
  const log2 = read(calls);
  assert.match(log2, /git -C \S+\/src fetch --depth 1 origin main/);
  assert.equal(log2.split('\n').filter((l) => /^docker rm -f clipgen-app/.test(l)).length, 2);
});
