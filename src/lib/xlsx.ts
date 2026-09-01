/**
 * Minimal XLSX reader with no dependencies.
 *
 * An .xlsx is a ZIP of XML. Browsers ship `DecompressionStream('deflate-raw')` and
 * `DOMParser`, which is everything needed — so we don't pull in SheetJS (whose npm
 * builds have been frozen at 0.18.5 since 2022 and carry unpatched advisories).
 *
 * Read-only, and only the parts we need: sheet names and cell text.
 */

export interface Sheet {
  name: string;
  /** Dense grid of trimmed cell strings; ragged rows are padded. */
  rows: string[][];
}

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;

// Hard bounds on the grid we are willing to materialize.
//
// `r` on <row> and <c> is attacker-controlled: it is just text in a file the
// user was handed. Both feed array indices that the padding pass at the end of
// readSheetRows walks DENSELY, so a single unchecked attribute turns a ~120
// byte part into gigabytes of allocation (`<row r="50000000">` alone costs
// ~9GB) and hangs the tab. A try/catch cannot help: nothing throws, it just
// allocates until the tab dies. These are the real Excel sheet limits, so no
// legitimate file is affected.
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

// The per-dimension caps still allow a huge PRODUCT (1M rows x 16k cols), and
// the padding pass materializes every cell. This bounds the grid as a whole;
// a real conference roster is a few thousand cells, so the headroom is large.
const MAX_CELLS = 2_000_000;

// Cap the decompressed size of a single ZIP part. `DecompressionStream` will
// happily inflate a small deflate bomb into unbounded memory otherwise.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEocd(view: DataView): number {
  // The EOCD is at the end, followed by an optional comment of up to 65535 bytes.
  const min = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record).');
}

function readCentralDirectory(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported. Re-export the sheet as CSV instead.');
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== SIG_CD) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const view = new DataView(buf);
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  // The central directory is attacker-controlled and may point outside the
  // file; Uint8Array would throw a bare RangeError, so fail with a real message.
  if (start < 0 || start + entry.compressedSize > buf.byteLength) {
    throw new Error(`Corrupt .xlsx: entry "${entry.name}" points outside the file.`);
  }
  const raw = new Uint8Array(buf, start, entry.compressedSize);

  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

  // Read incrementally so a deflate bomb is stopped mid-stream rather than
  // after it has already been fully materialized in memory.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel();
      throw new Error(
        `Refusing to decompress "${entry.name}": it expands beyond ` +
          `${MAX_ENTRY_BYTES / 1024 / 1024}MB. The file looks malformed or malicious.`,
      );
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Malformed XML inside the .xlsx file.');
  return doc;
}

/** "BC" -> 55 (1-based). Returns 0 for refs beyond the sheet limit. */
function colToIndex(ref: string): number {
  // A ref longer than 3 chars cannot be a real column ("XFD" is the last one),
  // and left unchecked it multiplies to an astronomical index below.
  if (ref.length > 3) return 0;
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n <= MAX_COLS ? n : 0;
}

function localName(el: Element): string {
  return el.localName ?? el.nodeName.replace(/^.*:/, '');
}

function textOfAllT(el: Element): string {
  let out = '';
  for (const t of Array.from(el.getElementsByTagName('*'))) {
    if (localName(t) === 't') out += t.textContent ?? '';
  }
  return out;
}

export async function readXlsx(file: File | Blob): Promise<Sheet[]> {
  const buf = await file.arrayBuffer();
  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const shared: string[] = [];
  const ssEntry = byName.get('xl/sharedStrings.xml');
  if (ssEntry) {
    const doc = parseXml(await readEntry(buf, ssEntry));
    for (const si of Array.from(doc.documentElement.children)) {
      if (localName(si) === 'si') shared.push(textOfAllT(si));
    }
  }

  // Map sheet name -> part path via workbook.xml + its rels.
  const wbEntry = byName.get('xl/workbook.xml');
  if (!wbEntry) throw new Error('Not a valid .xlsx file (missing xl/workbook.xml).');
  const wbDoc = parseXml(await readEntry(buf, wbEntry));

  const rels = new Map<string, string>();
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    const relDoc = parseXml(await readEntry(buf, relsEntry));
    for (const r of Array.from(relDoc.documentElement.children)) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }

  const sheetEls = Array.from(wbDoc.getElementsByTagName('*')).filter((e) => localName(e) === 'sheet');
  const out: Sheet[] = [];

  for (const el of sheetEls) {
    const name = el.getAttribute('name') ?? `Sheet${out.length + 1}`;
    const rid =
      el.getAttribute('r:id') ??
      el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const path = rid ? rels.get(rid) : undefined;
    const entry = path ? byName.get(path) : undefined;
    if (!entry) {
      out.push({ name, rows: [] });
      continue;
    }
    out.push({ name, rows: await readSheetRows(buf, entry, shared) });
  }

  return out;
}

async function readSheetRows(buf: ArrayBuffer, entry: ZipEntry, shared: string[]): Promise<string[][]> {
  const doc = parseXml(await readEntry(buf, entry));
  const grid: string[][] = [];
  let widest = 0;

  for (const rowEl of Array.from(doc.getElementsByTagName('*'))) {
    if (localName(rowEl) !== 'row') continue;
    const rawRowNum = Number(rowEl.getAttribute('r') ?? grid.length + 1);
    // Ignore junk/out-of-range `r` and fall back to positional order rather than
    // trusting it as an index (see MAX_ROWS). NaN fails every comparison, so the
    // explicit isInteger check is what actually rejects non-numeric refs.
    const rowNum =
      Number.isInteger(rawRowNum) && rawRowNum >= 1 && rawRowNum <= MAX_ROWS
        ? rawRowNum
        : grid.length + 1;
    const cells: string[] = [];

    for (const cEl of Array.from(rowEl.children)) {
      if (localName(cEl) !== 'c') continue;
      const ref = cEl.getAttribute('r') ?? '';
      const m = /^([A-Z]+)/.exec(ref);
      // colToIndex returns 0 for anything past the sheet limit; fall back to
      // append-order so a bogus ref costs one cell instead of the whole grid.
      const parsed = m ? colToIndex(m[1]) : 0;
      const col = parsed > 0 ? parsed : cells.length + 1;
      const type = cEl.getAttribute('t');

      let value = '';
      if (type === 's') {
        const vEl = Array.from(cEl.children).find((x) => localName(x) === 'v');
        const idx = vEl ? Number(vEl.textContent) : NaN;
        value = Number.isInteger(idx) ? (shared[idx] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOfAllT(cEl);
      } else {
        const vEl = Array.from(cEl.children).find((x) => localName(x) === 'v');
        value = vEl?.textContent ?? '';
      }

      cells[col - 1] = (value ?? '').trim();
      widest = Math.max(widest, col);
    }

    grid[rowNum - 1] = cells;
  }

  // Pad so consumers can index freely.
  // `grid.length` is driven by the largest `r` seen, not by how many rows were
  // actually present, so check the real cost before materializing anything.
  if (grid.length * Math.max(widest, 1) > MAX_CELLS) {
    throw new Error(
      `Sheet is too large to import (${grid.length} rows x ${widest} columns). ` +
        `The limit is ${MAX_CELLS.toLocaleString()} cells. If this is a normal ` +
        `spreadsheet, it likely contains a corrupt cell reference.`,
    );
  }
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < widest; c++) if (row[c] === undefined) row[c] = '';
    grid[r] = row;
  }
  return grid;
}

/** RFC4180-ish CSV parser: handles quoted fields, embedded commas, newlines and "". */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          let s = String(cell ?? '');
          // Neutralize CSV/formula injection: a value starting with = + - @
          // (or tab/CR) is read as a formula by Excel/Sheets on open. Only
          // applies to string cells — numeric cells here are always computed
          // values (counts, hours), never user-controlled text.
          if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(s)) {
            s = `'${s}`;
          }
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
}
