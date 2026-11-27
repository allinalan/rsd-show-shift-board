/*
  xlsx — a minimal .xlsx reader, no dependencies (this repo carries no node_modules).

  Reads what a hand-kept schedule workbook says with more than its values: per cell the value, the fill colour
  (the status, on a coordinator's colour-coded schedule), strike-through, the hyperlink, the comment; per sheet the
  merged ranges. Enough for scripts/import-workbook.mjs. Not a general spreadsheet library: no formulas evaluated
  (the cached value is read), no number formats, no conditional formatting, no rich-text runs kept apart.

    import { openWorkbook, cellRef } from './lib/xlsx.mjs';
    const wb = openWorkbook(fs.readFileSync(file));
    wb.sheetNames                       // ['January', ...] in tab order
    const sh = wb.sheet('January');     // { name, get(r, c), rows, cols, merges, cellCount }
    sh.get(0, 1)                        // row 1, column B (both 0-based): { v, fill, strike, link, comment } or undefined

  `v` is a number for a numeric cell, true/false for a boolean, otherwise a string. `fill` is the solid fill as
  'FFC9DAF8' (ARGB, upper case; a theme colour is resolved through the workbook's theme, tint included, and kept
  as 'theme:9' only when the file has no theme), 'indexed:13', or null for none (white counts as none). A cell with no value but a fill is kept (a coloured empty cell can still mean something).

  The zip is read from its central directory; entries are stored (method 0) or deflated (method 8, zlib's
  inflateRawSync). Anything else is refused by name, never guessed at.
*/
import zlib from 'node:zlib';

// ---------- zip -------------------------------------------------------------------------------
/** Map of entry name -> () => Buffer (inflated on first read). */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('xlsx: readZip wants a Buffer');
  // End of central directory: 22 bytes + up to 64 KiB of comment, searched from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: not a zip file (no end-of-central-directory record); is this really an .xlsx?');
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('xlsx: zip64 archives are not supported');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`xlsx: broken central directory at entry ${n}`);
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    let cached = null;
    entries.set(name, () => {
      if (cached) return cached;
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`xlsx: broken local header for ${name}`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) cached = Buffer.from(raw);
      else if (method === 8) cached = zlib.inflateRawSync(raw);
      else throw new Error(`xlsx: ${name} uses zip compression method ${method}; only stored (0) and deflate (8) are read`);
      if (cached.length !== usize) throw new Error(`xlsx: ${name} inflated to ${cached.length} bytes, the directory says ${usize}`);
      return cached;
    });
  }
  return entries;
}

// ---------- tiny XML helpers (the parts of OOXML this needs; regex over well-formed machine output) ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);
const attrs = tag => {
  const o = {};
  for (const m of String(tag).matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = unxml(m[2]);
  return o;
};
/** The text of every <t> in a fragment, skipping phonetic runs (<rPh>), joined. */
const textOf = frag => String(frag).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  .replace(/<t\b[^>]*\/>/g, '')
  .match(/<t\b[^>]*>[\s\S]*?<\/t>/g)?.map(t => unxml(t.replace(/^<t\b[^>]*>|<\/t>$/g, ''))).join('') ?? '';
/** Every <name ...>...</name> or <name .../> element, as { attrs, inner }. */
function* elements(xml, name) {
  const re = new RegExp(`<${name}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${name}>)`, 'g');
  for (const m of String(xml).matchAll(re)) yield { attrs: attrs(m[1]), inner: m[3] ?? '' };
}
const section = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`)); return m ? m[1] : ''; };

// ---------- cell references ---------------------------------------------------------------------
export const colName = c => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
/** 0-based row and column -> "B4". */
export const cellRef = (r, c) => `${colName(c)}${r + 1}`;
/** "B4" -> { r: 3, c: 1 } (0-based). */
export function parseRef(ref) {
  const m = String(ref).match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!m) throw new Error(`xlsx: not a cell reference: ${ref}`);
  let c = 0; for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
  return { r: +m[2] - 1, c: c - 1 };
}

// ---------- styles --------------------------------------------------------------------------------
/** The theme's colours in the order a fill's theme="n" counts them (lt1 and dk1 swapped, as Excel and Sheets both write it). */
function readTheme(xml) {
  if (!xml) return [];
  const scheme = section(xml, 'a:clrScheme');
  const pick = name => { const m = scheme.match(new RegExp(`<a:${name}>[\\s\\S]*?(?:srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})")`)); return m ? (m[1] || m[2]).toUpperCase() : null; };
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(pick);
}
const tinted = (hex, tint) => {
  if (!tint) return hex;
  return hex.match(/../g).map(h => { const v = parseInt(h, 16); const t = tint < 0 ? v * (1 + tint) : v + (255 - v) * tint; return Math.round(Math.max(0, Math.min(255, t))).toString(16).padStart(2, '0'); }).join('').toUpperCase();
};
function colorOf(attr, theme = []) {
  if (!attr) return null;
  if (attr.rgb) { const v = attr.rgb.toUpperCase(); return v.length === 6 ? 'FF' + v : v; }
  if (attr.theme !== undefined) {                    // resolved through the workbook's theme, so the key cell and a cell match by colour
    const base = theme[+attr.theme], tint = Number(attr.tint || 0);
    return base ? 'FF' + tinted(base, tint) : `theme:${attr.theme}${tint ? ':' + tint.toFixed(2) : ''}`;
  }
  if (attr.indexed !== undefined) return attr.indexed === '64' ? null : `indexed:${attr.indexed}`;   // 64 = "system foreground", i.e. none
  return null;
}
function readStyles(xml, theme) {
  const fills = [...elements(section(xml, 'fills'), 'fill')].map(f => {
    const pf = [...elements(f.inner, 'patternFill')][0];
    if (!pf || !pf.attrs.patternType || pf.attrs.patternType === 'none') return null;
    const fg = [...elements(pf.inner, 'fgColor')][0];
    const c = colorOf(fg && fg.attrs, theme);
    return c === 'FFFFFFFF' ? null : c;              // white is the sheet's own background, not a status
  });
  const fonts = [...elements(section(xml, 'fonts'), 'font')].map(f => ({
    strike: /<strike\b(?![^>]*val="(0|false)")/.test(f.inner),
  }));
  const xfs = [...elements(section(xml, 'cellXfs'), 'xf')].map(x => ({
    fill: fills[+(x.attrs.fillId || 0)] ?? null,
    strike: !!(fonts[+(x.attrs.fontId || 0)] || {}).strike,
  }));
  return xfs;
}

// ---------- the workbook ------------------------------------------------------------------------------
const relsOf = (zip, part) => {
  const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '';
  const relPath = `${dir ? dir + '/' : ''}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
  const get = zip.get(relPath);
  const out = new Map();
  if (!get) return out;
  for (const r of elements(get().toString('utf8'), 'Relationship')) {
    const external = r.attrs.TargetMode === 'External';
    out.set(r.attrs.Id, { type: String(r.attrs.Type || '').split('/').pop(), target: external ? r.attrs.Target : resolvePart(dir, r.attrs.Target), external });
  }
  return out;
};
function resolvePart(dir, target) {
  if (!target) return target;
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir ? dir.split('/') : []);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}

/** Open an .xlsx held in a Buffer. Sheets are parsed on first use. */
export function openWorkbook(buf) {
  const zip = readZip(buf);
  const need = name => { const g = zip.get(name); if (!g) throw new Error(`xlsx: no ${name} in the file; is this an .xlsx workbook?`); return g().toString('utf8'); };
  const wbXml = need('xl/workbook.xml');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wbXml);
  const wbRels = relsOf(zip, 'xl/workbook.xml');
  const shared = zip.get('xl/sharedStrings.xml') ? [...elements(zip.get('xl/sharedStrings.xml')().toString('utf8'), 'si')].map(si => textOf(si.inner)) : [];
  const themePart = [...wbRels.values()].find(r => r.type === 'theme');
  const theme = readTheme(themePart && zip.get(themePart.target) ? zip.get(themePart.target)().toString('utf8') : '');
  const xfs = zip.get('xl/styles.xml') ? readStyles(zip.get('xl/styles.xml')().toString('utf8'), theme) : [];
  const sheets = [...elements(section(wbXml, 'sheets'), 'sheet')].map(s => ({ name: s.attrs.name, part: (wbRels.get(s.attrs['r:id']) || {}).target, state: s.attrs.state || 'visible' }));
  const cache = new Map();

  function sheet(name) {
    if (cache.has(name)) return cache.get(name);
    const meta = sheets.find(s => s.name === name);
    if (!meta) throw new Error(`xlsx: no tab "${name}". Tabs: ${sheets.map(s => s.name).join(', ')}`);
    if (!meta.part || !zip.get(meta.part)) throw new Error(`xlsx: tab "${name}" points at ${meta.part}, which is not in the file`);
    const xml = zip.get(meta.part)().toString('utf8');
    const cells = new Map();
    let rows = 0, cols = 0;
    const key = (r, c) => r * 16384 + c;
    for (const c of elements(section(xml, 'sheetData'), 'c')) {
      if (!c.attrs.r) continue;                       // every Google/Excel export writes r; a cell without one cannot be placed
      const { r, c: col } = parseRef(c.attrs.r);
      const st = xfs[+(c.attrs.s || 0)] || { fill: null, strike: false };
      const vm = c.inner.match(/<v>([\s\S]*?)<\/v>/);
      let v = null;
      const t = c.attrs.t || 'n';
      if (t === 's') v = vm ? (shared[+vm[1]] ?? '') : null;
      else if (t === 'inlineStr') v = textOf(c.inner);
      else if (t === 'str' || t === 'e') v = vm ? unxml(vm[1]) : null;
      else if (t === 'b') v = vm ? vm[1] === '1' : null;
      else if (vm) { const n = Number(vm[1]); v = Number.isFinite(n) ? n : unxml(vm[1]); }
      if ((v === null || v === '') && !st.fill) continue;
      cells.set(key(r, col), { v: v === null ? '' : v, fill: st.fill, strike: st.strike, link: null, comment: null });
      rows = Math.max(rows, r + 1); cols = Math.max(cols, col + 1);
    }
    const rels = relsOf(zip, meta.part);
    const touch = (r, c) => { const k = key(r, c); if (!cells.has(k)) cells.set(k, { v: '', fill: null, strike: false, link: null, comment: null }); rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1); return cells.get(k); };
    for (const h of elements(section(xml, 'hyperlinks'), 'hyperlink')) {
      const target = h.attrs['r:id'] ? (rels.get(h.attrs['r:id']) || {}).target : (h.attrs.location ? '#' + h.attrs.location : null);
      if (!target || !h.attrs.ref) continue;
      const first = h.attrs.ref.split(':')[0];
      const { r, c } = parseRef(first);
      touch(r, c).link = target;
    }
    for (const rel of rels.values()) {
      if (rel.type !== 'comments' || rel.external || !zip.get(rel.target)) continue;
      for (const cm of elements(section(zip.get(rel.target)().toString('utf8'), 'commentList'), 'comment')) {
        if (!cm.attrs.ref) continue;
        const { r, c } = parseRef(cm.attrs.ref.split(':')[0]);
        const cell = touch(r, c);
        const text = textOf(cm.inner).replace(/\r\n?/g, '\n').trim();
        cell.comment = cell.comment ? `${cell.comment}\n${text}` : text;
      }
    }
    const merges = [...elements(xml, 'mergeCell')].map(m => {
      const [a, b] = String(m.attrs.ref || '').split(':');
      const s = parseRef(a), e = parseRef(b || a);
      return { r0: s.r, c0: s.c, r1: e.r, c1: e.c, ref: m.attrs.ref };
    });
    const out = { name, rows, cols, merges, cellCount: cells.size, get: (r, c) => cells.get(key(r, c)) };
    cache.set(name, out);
    return out;
  }
  return { sheetNames: sheets.map(s => s.name), sheets: sheets.map(({ name, state }) => ({ name, state })), date1904, sheet };
}

/** An Excel serial day -> a UTC Date (whole days; the 1900 leap-year bug is inside the epoch). */
export function serialToDate(n, date1904 = false) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.floor(n) * 86400000);
}

// ---------- writing a tiny workbook (tests only need it; kept here so the reader and writer agree) ----
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = b => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
/**
 * A zip of { name: string|Buffer }, every entry stored (method 0), or deflated when `deflate` is true. The tests use
 * it to build a workbook in memory; nothing in the importer writes zips.
 */
export function writeZip(files, { deflate = false } = {}) {
  const locals = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data, nm = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, body); central.push(ch, nm); off += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
