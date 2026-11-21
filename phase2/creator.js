/*
  ClipGen AI · Phase 2 · Creator Studio (for creators who WANT their videos clipped).

  What it does, all inside this browser (nothing is uploaded; the private key never leaves the device):
    1. creates your signing key (ECDSA P-256, built-in WebCrypto)
    2. builds your REGISTRATION REQUEST (public key + channel + manifest address) for the ClipGen maintainer
    3. builds and SIGNS your MANIFEST: which videos you approve, where your original file for each is hosted,
       the file's SHA-256 (computed here, in chunks) and your terms
    4. lets you (or the maintainer) CHECK a registry entry + manifest the same way ClipGen AI will

  What it does NOT do: host your files, and it never touches YouTube. You put the signed manifest and your
  original video files on a host you control (it must allow cross-origin reads, see CREATOR-AUTHORIZATION.md).
*/
import { generateKeyPair, signPayload, verifySignature, thumbprint, sha256OfBlob, publicParts } from './crypto-utils.js';
import { MANIFEST_FORMAT, REGISTRY_FORMAT, SIG_ALG, isAllowedUrl, validateRegistry, verifyManifest, findGrant } from './authz.js';
import { parseYouTubeUrl } from './youtube.js';

const $ = (s, r) => (r || document).querySelector(s);
const view = $('#view');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const errText = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };
const fmtSize = (b) => (b < 1e6 ? Math.round(b / 1e3) + ' KB' : b < 1e9 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e9).toFixed(2) + ' GB');
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } }
function toast(text, kind) {
  const d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.textContent = text;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), kind === 'bad' ? 6500 : 3200);
}
function busy(text) {
  const b = $('#busy');
  if (text) { $('#busyText').textContent = text; b.classList.remove('hidden'); } else b.classList.add('hidden');
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied.', 'ok'); }
  catch (_) { toast('Select the text and copy it manually.'); }
}

const KEY_LS = 'clipgen.creator.key.v1';
const PROFILE_LS = 'clipgen.creator.profile.v1';
const st = {
  key: null,                 // { publicJwk, privateJwk, keyId }
  profile: { id: '', displayName: '', handle: '', channelId: '', manifestUrl: '' },
  videos: [],                // manifest entries being built
  pending: null,             // file chosen for the next video row { file, sha256 }
  signed: null, regOut: '', checkOut: null
};
try { const k = JSON.parse(lsGet(KEY_LS) || 'null'); if (k && k.privateJwk && k.publicJwk && k.keyId) st.key = k; } catch (_) { /* ignore */ }
try { const p = JSON.parse(lsGet(PROFILE_LS) || 'null'); if (p) Object.assign(st.profile, p); } catch (_) { /* ignore */ }

const slugOk = (s) => /^[a-z0-9][a-z0-9-]{2,39}$/.test(s);
const challengeOf = (keyId) => 'clipgen-verify-' + keyId.slice(0, 16);

/* ---------------- rendering ---------------- */
function html() {
  const k = st.key, p = st.profile;
  return '' +
  '<section class="hero"><h1>Creator <span class="grad">Studio</span></h1>' +
  '<p class="lead">Let ClipGen AI clip your videos — with your approval, from your original files, and nothing downloaded from YouTube.</p></section>' +
  '<div class="rule-box"><b>How this works.</b> YouTube does not let anyone download its videos, and a “yes” from a creator cannot change that. So you approve specific videos by publishing a <b>signed list</b> that points to <b>your own original files</b> on a host you control. ClipGen AI checks the signature, the registry entry and each file’s fingerprint before it uses anything. Read <a class="lnk" href="CREATOR-AUTHORIZATION.md" target="_blank" rel="noopener noreferrer">CREATOR-AUTHORIZATION.md ↗</a>.</div>' +

  '<section class="card" style="margin-top:14px" id="keyCard"><div class="card-head"><h2><span class="step-n">1</span>Your signing key</h2>' + (k ? '<span class="pill pill-ok">Ready</span>' : '<span class="pill pill-warn">Not created</span>') + '</div>' +
    (k
      ? '<div class="mchip wide" style="margin-bottom:8px"><div class="k">Key ID</div><div class="v" style="white-space:normal;overflow-wrap:anywhere;font-size:12.5px">' + esc(k.keyId) + '</div></div>' +
        '<p class="card-note" style="margin-top:0">The private half lives only in this browser. <b>Download a backup</b> and keep it safe: Safari can clear website data, and without the key you cannot sign changes. If it ever leaks, tell the ClipGen maintainer so your entry can be revoked.</p>' +
        '<div class="row"><button class="btn btn-sm" id="kBackup" type="button">Download key backup</button><button class="btn btn-sm btn-danger" id="kForget" type="button">Forget key on this device</button></div>'
      : '<p class="card-note" style="margin-top:0">Creates a P-256 signing key with your browser’s built-in cryptography. No account, no server.</p>' +
        '<div class="row"><button class="btn btn-primary" id="kCreate" type="button">Create my signing key</button></div>' +
        '<details class="howto"><summary>I already have a backup</summary><div class="howto-body"><label class="btn btn-sm" for="kFile">Choose key backup file</label><input class="sr-only" id="kFile" type="file" accept="application/json,.json"></div></details>') +
  '</section>' +

  '<section class="card" id="regCard"><div class="card-head"><h2><span class="step-n">2</span>Register your channel</h2><span class="pill">Once</span></div>' +
    '<p class="card-note" style="margin-top:0">This builds a request for the ClipGen maintainer. They check that you control the channel (you put a short code in your channel’s About text), then set you to “verified”. Until then nothing of yours is processed.</p>' +
    '<div class="form-grid">' +
      '<label class="f">Short ID (letters, numbers, dashes)<input class="text-input" id="pId" value="' + esc(p.id) + '" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="my-channel"></label>' +
      '<label class="f">Channel name<input class="text-input" id="pName" value="' + esc(p.displayName) + '" placeholder="My Channel"></label>' +
      '<label class="f">Channel handle<input class="text-input" id="pHandle" value="' + esc(p.handle) + '" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="@mychannel"></label>' +
      '<label class="f">Channel ID (optional, starts with UC — makes matching exact)<input class="text-input" id="pChan" value="' + esc(p.channelId) + '" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="UC…"></label>' +
      '<label class="f">Where you will publish your signed manifest (https)<input class="text-input" id="pUrl" value="' + esc(p.manifestUrl) + '" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://example.com/clipgen-manifest.json"></label>' +
    '</div>' +
    '<div class="row"><button class="btn btn-primary" id="regBuild" type="button"' + (k ? '' : ' disabled aria-disabled="true"') + '>Build my registration request</button></div>' +
    '<div id="regOut" aria-live="polite">' + (st.regOut ? regOutHtml() : '') + '</div>' +
  '</section>' +

  '<section class="card" id="manCard"><div class="card-head"><h2><span class="step-n">3</span>Approve videos &amp; sign</h2><span class="pill">Each time</span></div>' +
    '<p class="card-note" style="margin-top:0">For each video you approve: choose your <b>original file</b> (it is fingerprinted here, not uploaded), say where it is hosted, and set your terms. Then sign. You publish the signed manifest and the files yourself.</p>' +
    '<div class="form-grid">' +
      '<label class="f">YouTube link of the video<input class="text-input" id="vLink" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://youtu.be/…"></label>' +
      '<div><label class="btn btn-sm" for="vFile">' + (st.pending ? 'Change file' : 'Choose original file (MP4/MOV)') + '</label><input class="sr-only" id="vFile" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">' +
        (st.pending ? '<div class="card-note" style="overflow-wrap:anywhere">✓ ' + esc(st.pending.file.name) + ' · ' + fmtSize(st.pending.file.size) + '<br>SHA-256 ' + esc(st.pending.sha256.slice(0, 16)) + '…</div>' : '') + '</div>' +
      '<label class="f">Public https address of that exact file<input class="text-input" id="vUrl" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://example.com/files/my-video.mp4"></label>' +
      '<label class="opt"><input type="checkbox" id="tCap" checked><span><b>Captions allowed</b></span></label>' +
      '<label class="opt"><input type="checkbox" id="tVert" checked><span><b>Vertical (9:16) export allowed</b></span></label>' +
      '<label class="opt"><input type="checkbox" id="tAttr"><span><b>Require attribution</b></span></label>' +
      '<label class="f">Attribution text (if required)<input class="text-input" id="tAttrText" maxlength="300" placeholder="Clipped from My Channel"></label>' +
    '</div>' +
    '<div class="row"><button class="btn btn-primary" id="vAdd" type="button">Add this video</button></div>' +
    '<ul class="vlist" id="vList">' + videosHtml() + '</ul>' +
    '<div class="row"><button class="btn btn-primary" id="mSign" type="button"' + (k && st.videos.length ? '' : ' disabled aria-disabled="true"') + '>Sign manifest (' + st.videos.length + ' video' + (st.videos.length === 1 ? '' : 's') + ')</button></div>' +
    '<div id="mOut" aria-live="polite">' + (st.signed ? signedHtml() : '') + '</div>' +
  '</section>' +

  '<section class="card" id="chkCard"><div class="card-head"><h2><span class="step-n">4</span>Check an entry and manifest</h2><span class="pill">Optional</span></div>' +
    '<p class="card-note" style="margin-top:0">Runs the same checks ClipGen AI runs. Paste a registry entry and a manifest (for example to test before you publish, or for the maintainer to confirm a request). It does not change anything.</p>' +
    '<textarea class="text-input mono" id="cEntry" rows="5" placeholder="Registry entry (JSON)" aria-label="Registry entry JSON"></textarea>' +
    '<textarea class="text-input mono" id="cMan" rows="5" placeholder="Signed manifest (JSON)" aria-label="Manifest JSON"></textarea>' +
    '<div class="row"><button class="btn btn-sm" id="cRun" type="button">Check</button></div><div id="cOut" aria-live="polite"></div>' +
  '</section>';
}
function regOutHtml() {
  return '<p class="card-note"><b>Send this to the ClipGen maintainer</b> (for example as a new issue or pull request on the ClipGen AI GitHub repository), and put the code below in your channel’s About text so they can confirm it is you:</p>' +
    '<div class="mchip wide"><div class="k">Verification code</div><div class="v" style="white-space:normal;overflow-wrap:anywhere">' + esc(challengeOf(st.key.keyId)) + '</div></div>' +
    '<pre class="out" id="regPre">' + esc(st.regOut) + '</pre><div class="row"><button class="btn btn-sm" id="regCopy" type="button">Copy request</button></div>';
}
function videosHtml() {
  if (!st.videos.length) return '<li class="muted">No videos added yet.</li>';
  return st.videos.map((v, i) => '<li><b>' + esc(v.source.name) + '</b><br><span class="muted">' + esc(v.videoId) + ' · ' + esc(fmtSize(v.source.size)) + ' · ' + esc(v.source.url) + '</span><br>' +
    '<button class="btn btn-sm btn-danger" type="button" data-rm="' + i + '">Remove</button></li>').join('');
}
function signedHtml() {
  return '<div class="msg msg-info"><b>Signed.</b> ' + esc(st.signed.note) + '</div>' +
    '<pre class="out" id="manPre">' + esc(st.signed.text) + '</pre>' +
    '<div class="row"><button class="btn btn-sm" id="manCopy" type="button">Copy manifest</button><a class="btn btn-sm" id="manDl" href="' + st.signed.url + '" download="clipgen-manifest.json">Download clipgen-manifest.json</a></div>' +
    '<p class="card-note">Publish this file at the address you gave in step 2 (' + esc(st.profile.manifestUrl || 'not set yet') + '), and host each original file at the address you entered. Both must allow reading from other websites (CORS).</p>';
}
function render() {
  view.innerHTML = html();
  wire();
}
function rerenderKeep() {      // re-render but keep what the user is typing
  const ids = ['vLink', 'vUrl', 'tAttrText', 'cEntry', 'cMan'];
  const vals = {}; ids.forEach((i) => { const e = $('#' + i); if (e) vals[i] = e.value; });
  const checks = {}; ['tCap', 'tVert', 'tAttr'].forEach((i) => { const e = $('#' + i); if (e) checks[i] = e.checked; });
  render();
  ids.forEach((i) => { const e = $('#' + i); if (e && vals[i] != null) e.value = vals[i]; });
  Object.keys(checks).forEach((i) => { const e = $('#' + i); if (e) e.checked = checks[i]; });
}

/* ---------------- actions ---------------- */
function readProfile() {
  const g = (id) => ($('#' + id) ? $('#' + id).value.trim() : '');
  st.profile = { id: g('pId').toLowerCase(), displayName: g('pName'), handle: g('pHandle'), channelId: g('pChan'), manifestUrl: g('pUrl') };
  lsSet(PROFILE_LS, JSON.stringify(st.profile));
}
function saveKey() { return lsSet(KEY_LS, JSON.stringify(st.key)); }

async function createKey() {
  try {
    busy('Creating your key …');
    st.key = await generateKeyPair();
    busy(null);
    if (!saveKey()) toast('Could not remember the key in this browser — download the backup now.', 'bad');
    toast('Key created. Download the backup next.', 'ok');
    render();
  } catch (e) { busy(null); toast('Could not create a key: ' + errText(e), 'bad'); }
}
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function restoreKey(file) {
  try {
    const k = JSON.parse(await file.text());
    if (!k || !k.privateJwk || !k.publicJwk) throw new Error('This is not a ClipGen key backup.');
    const pub = publicParts(k.publicJwk);
    const keyId = thumbprint(pub);
    if (k.keyId && k.keyId !== keyId) throw new Error('The key ID in the backup does not match its public key.');
    const test = { t: 'self-test' };
    const sig = await signPayload(k.privateJwk, test);
    if (!(await verifySignature(pub, test, sig))) throw new Error('The private key does not match the public key.');
    st.key = { publicJwk: pub, privateJwk: k.privateJwk, keyId };
    saveKey(); toast('Key restored.', 'ok'); render();
  } catch (e) { toast('Could not restore: ' + errText(e), 'bad'); }
}
function buildRegistration() {
  readProfile();
  const p = st.profile;
  const bad = (m) => { toast(m, 'bad'); };
  if (!slugOk(p.id)) return bad('Short ID: 3–40 letters, numbers or dashes (lowercase).');
  if (!p.displayName || p.displayName.length > 80) return bad('Enter your channel name (up to 80 characters).');
  if (!p.handle && !p.channelId) return bad('Enter your channel handle (like @mychannel) or channel ID.');
  if (p.handle && !/^@[A-Za-z0-9._-]{3,60}$/.test(p.handle)) return bad('The handle should look like @mychannel.');
  if (p.channelId && !/^UC[A-Za-z0-9_-]{22}$/.test(p.channelId)) return bad('A channel ID starts with UC and is 24 characters long.');
  if (!isAllowedUrl(p.manifestUrl)) return bad('The manifest address must start with https://');
  const channel = {};
  if (p.handle) channel.handle = p.handle;
  if (p.channelId) channel.channelId = p.channelId;
  const entry = { id: p.id, displayName: p.displayName, status: 'pending', channel, keyId: st.key.keyId, publicKey: publicParts(st.key.publicJwk), manifestUrl: p.manifestUrl };
  st.regOut = JSON.stringify(entry, null, 2);
  render();
  const e = $('#regOut'); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest' });
}

async function chooseVideoFile(file) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(file.name) || [])[1];
  if (!ext || ['mp4', 'mov', 'm4v'].indexOf(ext.toLowerCase()) < 0) { toast('Choose an .mp4 or .mov file.', 'bad'); return; }
  if (!file.size) { toast('That file is empty.', 'bad'); return; }
  try {
    busy('Fingerprinting the file (SHA-256) … 0%');
    const hex = await sha256OfBlob(file, { onProgress: (x) => { const t = $('#busyText'); if (t) t.textContent = 'Fingerprinting the file (SHA-256) … ' + Math.round(x * 100) + '%'; } });
    busy(null);
    st.pending = { file, sha256: hex };
    rerenderKeep();
  } catch (e) { busy(null); toast('Could not read the file: ' + errText(e), 'bad'); }
}
function addVideo() {
  const r = parseYouTubeUrl($('#vLink').value);
  if (!r.ok) { toast(r.message, 'bad'); return; }
  if (!st.pending) { toast('Choose the original file first.', 'bad'); return; }
  const url = $('#vUrl').value.trim();
  if (!isAllowedUrl(url)) { toast('The file address must start with https://', 'bad'); return; }
  if (st.videos.some((v) => v.videoId === r.videoId)) { toast('That video is already in the list.', 'bad'); return; }
  const f = st.pending.file;
  const ext = f.name.split('.').pop().toLowerCase();
  const attr = $('#tAttr').checked;
  const text = $('#tAttrText').value.trim();
  if (attr && !text) { toast('Enter the attribution text, or untick “Require attribution”.', 'bad'); return; }
  st.videos.push({
    videoId: r.videoId,
    source: { url, sha256: st.pending.sha256, size: f.size, type: ext === 'mov' ? 'video/quicktime' : 'video/mp4', name: f.name },
    terms: { clipping: true, captions: $('#tCap').checked, verticalExport: $('#tVert').checked, attributionRequired: attr, attributionText: attr ? text : '', expiresAt: null }
  });
  st.pending = null; st.signed = null;
  $('#vLink').value = ''; $('#vUrl').value = '';
  rerenderKeep();
  toast('Video added.', 'ok');
}
async function signManifest() {
  readProfile();
  if (!slugOk(st.profile.id)) { toast('Fill in your short ID in step 2 first — the manifest names you by it.', 'bad'); return; }
  try {
    busy('Signing …');
    const now = new Date();
    const exp = new Date(now.getTime() + 365 * 86400000);
    const payload = { creatorId: st.profile.id, issuedAt: now.toISOString(), expiresAt: exp.toISOString(), videos: st.videos };
    const value = await signPayload(st.key.privateJwk, payload);
    const manifest = { format: MANIFEST_FORMAT, payload, signature: { alg: SIG_ALG, keyId: st.key.keyId, value } };
    // self-check exactly as ClipGen AI will do it
    const chk = await verifyManifest(manifest, { id: st.profile.id, keyId: st.key.keyId, publicKey: publicParts(st.key.publicJwk) }, {});
    busy(null);
    if (!chk.ok) { toast('The manifest failed its own check: ' + chk.message, 'bad'); return; }
    const text = JSON.stringify(manifest, null, 2);
    if (st.signed && st.signed.url) URL.revokeObjectURL(st.signed.url);
    st.signed = { text, url: URL.createObjectURL(new Blob([text], { type: 'application/json' })), note: 'It passed the same signature and format checks ClipGen AI runs. It is valid for 365 days; sign again to add or remove videos.' };
    rerenderKeep();
  } catch (e) { busy(null); toast('Signing failed: ' + errText(e), 'bad'); }
}
async function runCheck() {
  const out = $('#cOut');
  const rows = [];
  const row = (ok, text) => rows.push('<li class="' + (ok === true ? 'ok' : ok === false ? 'bad' : 'unk') + '"><span class="ck" aria-hidden="true">' + (ok === true ? '✓' : ok === false ? '✗' : '?') + '</span><span>' + esc(text) + '</span></li>');
  let entry, man;
  try { entry = JSON.parse($('#cEntry').value); } catch (_) { out.innerHTML = '<div class="msg msg-bad">The registry entry is not valid JSON.</div>'; return; }
  const reg = await validateRegistry({ format: REGISTRY_FORMAT, creators: [entry] }, {});
  row(reg.creators.length === 1, reg.creators.length === 1 ? 'Registry entry is well-formed (key ID matches the public key)' : 'Registry entry rejected: ' + (reg.rejected[0] ? reg.rejected[0].reason : 'invalid'));
  if (reg.creators.length === 1) {
    row(entry.status === 'verified' ? true : null, 'Status is “' + entry.status + '”' + (entry.status === 'verified' ? '' : ' — ClipGen AI will not process anything until the maintainer sets it to verified'));
    if (entry.status === 'pending' && entry.keyId) row(null, 'Maintainer: confirm the channel About text contains ' + challengeOf(entry.keyId));
    const txt = $('#cMan').value.trim();
    if (txt) {
      try { man = JSON.parse(txt); } catch (_) { man = null; row(false, 'The manifest is not valid JSON'); }
      if (man) {
        const vm = await verifyManifest(man, reg.creators[0], { allowLocalHttp: false });
        row(vm.ok, vm.ok ? 'Manifest signature, creator, dates and entries are valid (' + vm.payload.videos.length + ' video' + (vm.payload.videos.length === 1 ? '' : 's') + ')' : vm.message);
        if (vm.ok) vm.payload.videos.forEach((v) => { const g = findGrant(vm.payload, v.videoId); row(g.ok, v.videoId + ' — ' + (g.ok ? 'approved for clipping' : g.message)); });
      }
    }
  }
  out.innerHTML = '<ul class="checks">' + rows.join('') + '</ul>';
}

/* ---------------- wiring ---------------- */
function wire() {
  const on = (id, ev, fn) => { const e = $('#' + id); if (e) e.addEventListener(ev, fn); };
  on('kCreate', 'click', createKey);
  on('kBackup', 'click', () => downloadText('clipgen-creator-key.json', JSON.stringify({ format: 'clipgen-key/1', keyId: st.key.keyId, publicJwk: st.key.publicJwk, privateJwk: st.key.privateJwk }, null, 2)));
  on('kForget', 'click', () => { if (!confirm('Forget the key on this device? Without a backup you will not be able to sign again.')) return; try { localStorage.removeItem(KEY_LS); } catch (_) { /* ignore */ } st.key = null; st.signed = null; st.regOut = ''; render(); });
  on('kFile', 'change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) restoreKey(f); });
  on('regBuild', 'click', buildRegistration);
  on('regCopy', 'click', () => copyText(st.regOut, 'Request copied.'));
  on('vFile', 'change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) chooseVideoFile(f); });
  on('vAdd', 'click', addVideo);
  on('mSign', 'click', signManifest);
  on('manCopy', 'click', () => copyText(st.signed.text, 'Manifest copied.'));
  on('cRun', 'click', runCheck);
  ['pId', 'pName', 'pHandle', 'pChan', 'pUrl'].forEach((id) => on(id, 'change', readProfile));
  const list = $('#vList');
  if (list) list.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('[data-rm]') : null;
    if (!b) return;
    st.videos.splice(Number(b.getAttribute('data-rm')), 1); st.signed = null; rerenderKeep();
  });
}
render();
