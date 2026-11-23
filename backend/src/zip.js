/* ClipGen AI backend · minimal streaming ZIP writer ("stored", no compression: MP4 is already compressed). */
import fs from 'node:fs';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf, crc = 0) { crc = ~crc >>> 0; for (let i = 0; i < buf.length; i++) crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return ~crc >>> 0; }

function dosTime(d) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }

/* entries: [{ name, path }]; writes to a writable stream; resolves when finished */
export async function writeZip(out, entries) {
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('closed'));
    if (out.write(buf)) return resolve();
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('closed')); };
    const cleanup = () => { out.off('drain', done); out.off('close', fail); out.off('error', fail); };
    out.once('drain', done); out.once('close', fail); out.once('error', fail);
  });
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(now.time, 10); lh.writeUInt16LE(now.date, 12); lh.writeUInt32LE(0, 14); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28); name.copy(lh, 30);
    await write(lh);
    let crc = 0, size = 0;
    for await (const chunk of fs.createReadStream(e.path)) { crc = crc32(chunk, crc); size += chunk.length; await write(chunk); }
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12);
    await write(dd);
    central.push({ name, crc, size, offset });
    offset += lh.length + size + dd.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const h = Buffer.alloc(46 + c.name.length);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(now.time, 12); h.writeUInt16LE(now.date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(0, 34); h.writeUInt32LE(c.offset, 42); c.name.copy(h, 46);
    await write(h); cdSize += h.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}
