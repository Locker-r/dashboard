(function exposeLeadImport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationLeadImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLeadImport() {
  'use strict';

  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_ROWS = 10000;
  const HEADER_ALIASES = Object.freeze({
    phone: 'phone', 'телефон': 'phone',
    email: 'email', 'почта': 'email',
    contact: 'contact', 'контакт': 'contact', telegram: 'contact', whatsapp: 'contact', messenger: 'contact'
  });

  function normalizePhone(value) {
    let normalized = String(value || '').trim().replace(/\D/g, '');
    if (normalized.startsWith('00')) normalized = normalized.slice(2);
    return normalized;
  }

  function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
  function normalizeContact(value) { return String(value || '').trim().toLowerCase(); }
  function validEmail(value) { return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

  function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    if (!source.trim()) return [];
    const firstLine = source.split(/\r?\n/, 1)[0];
    let commas = 0, semicolons = 0, quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === '"') quoted = !quoted;
      else if (!quoted && firstLine[i] === ',') commas++;
      else if (!quoted && firstLine[i] === ';') semicolons++;
    }
    const delimiter = semicolons > commas ? ';' : ',';
    const rows = [], row = [];
    let field = '', inQuotes = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (inQuotes) {
        if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') inQuotes = false;
        else field += char;
      } else if (char === '"' && field.length === 0) inQuotes = true;
      else if (char === delimiter) { row.push(field.trim()); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        row.push(field.trim()); field = '';
        if (row.some(value => value !== '')) rows.push(row.splice(0)); else row.length = 0;
      } else field += char;
    }
    row.push(field.trim());
    if (row.some(value => value !== '')) rows.push(row);
    return rows;
  }

  function headerMapping(row) {
    const mapping = {};
    row.forEach((value, index) => {
      const field = HEADER_ALIASES[String(value || '').trim().toLowerCase()];
      if (field && mapping[field] === undefined) mapping[field] = index;
    });
    return mapping;
  }

  function duplicateKeys(record) {
    const keys = [];
    const phone = normalizePhone(record.phone);
    const email = normalizeEmail(record.email);
    const contact = normalizeContact(record.contact || record.messenger);
    if (phone) keys.push(`phone:${phone}`);
    if (email) keys.push(`email:${email}`);
    if (contact) keys.push(`contact:${contact}`);
    return keys;
  }

  function prepareCsvImport(text, existingPlayers, options) {
    const config = options || {};
    if (Number.isFinite(config.fileSize) && config.fileSize > MAX_FILE_BYTES) return { ok: false, reason: 'file_too_large' };
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, reason: 'empty_file' };
    if (rows.length > MAX_ROWS + 1) return { ok: false, reason: 'too_many_rows' };
    const detected = headerMapping(rows[0]);
    const hasHeader = Object.keys(detected).length > 0;
    const mapping = hasHeader ? detected : { phone: 0, email: 1, contact: 2 };
    if (![mapping.phone, mapping.email, mapping.contact].some(Number.isInteger)) return { ok: false, reason: 'unrecognized_structure' };
    const dataRows = rows.slice(hasHeader ? 1 : 0);
    if (!dataRows.length) return { ok: false, reason: 'empty_file' };
    if (dataRows.length > MAX_ROWS) return { ok: false, reason: 'too_many_rows' };
    const seen = new Set((Array.isArray(existingPlayers) ? existingPlayers : []).flatMap(duplicateKeys));
    const valid = [], errors = [], duplicates = [];
    dataRows.forEach((columns, index) => {
      const rowNumber = index + (hasHeader ? 2 : 1);
      const record = {
        phone: mapping.phone === undefined ? '' : String(columns[mapping.phone] || '').trim(),
        email: mapping.email === undefined ? '' : String(columns[mapping.email] || '').trim(),
        contact: mapping.contact === undefined ? '' : String(columns[mapping.contact] || '').trim()
      };
      if (!record.phone && !record.email && !record.contact) { errors.push({ rowNumber, reason: 'empty_row' }); return; }
      if (!validEmail(record.email)) { errors.push({ rowNumber, reason: 'invalid_email', record }); return; }
      const keys = duplicateKeys(record);
      if (keys.some(key => seen.has(key))) { duplicates.push({ rowNumber, reason: 'duplicate', record }); return; }
      keys.forEach(key => seen.add(key));
      valid.push({ rowNumber, ...record });
    });
    return { ok: true, total: dataRows.length, valid, errors, duplicates, hasHeader };
  }

  function validateFile(file) {
    const name = String(file && file.name || '');
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    if (extension === '.xlsx') return { ok: false, reason: 'xlsx_unavailable' };
    if (extension !== '.csv') return { ok: false, reason: 'unsupported_format' };
    if (Number(file && file.size) > MAX_FILE_BYTES) return { ok: false, reason: 'file_too_large' };
    return { ok: true };
  }

  function appendPrepared(existingPlayers, preview, createPlayer) {
    const existing = Array.isArray(existingPlayers) ? existingPlayers : [];
    if (!preview || !preview.ok) return existing.slice();
    return existing.concat(preview.valid.map(row => createPlayer(row)));
  }

  return Object.freeze({ MAX_FILE_BYTES, MAX_ROWS, parseCsv, prepareCsvImport, validateFile, duplicateKeys, appendPrepared });
});
