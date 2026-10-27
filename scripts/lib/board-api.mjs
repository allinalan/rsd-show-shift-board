/*
  board-api — the REST calls the unattended routines (sheet-sync, event-check) make against the
  board's Supabase tables. Same env file and the same merge_doc path as scripts/board.mjs, so every
  write lands in the changelog with its actor. No dependencies: Node 18+ and fetch.

  Promoter contact/phone/email live in `event_contacts`, never in `events` (this repo and the
  `events` seed are public). Writers here take a patch, split those three fields out and send them
  to their own table, exactly as board.mjs does.
*/
import fs from 'fs';
import os from 'os';
import path from 'path';

export const PRIVATE = ['contact', 'phone', 'email'];
export const splitPriv = o => {
  const pub = {}, priv = {};
  for (const k of Object.keys(o || {})) (PRIVATE.includes(k) ? priv : pub)[k] = o[k];
  return { pub, priv };
};

export function loadEnv() {
  const f = path.join(os.homedir(), '.rsd', 'board.env');
  if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const url = process.env.BOARD_SUPABASE_URL, key = process.env.BOARD_SERVICE_KEY;
  if (!url || !key) throw new Error('BOARD_SUPABASE_URL and BOARD_SERVICE_KEY are not set. Put them in ~/.rsd/board.env (see scripts/board.mjs).');
  return { url: url.replace(/\/$/, ''), key };
}

export function boardApi({ actor } = {}) {
  const env = loadEnv();
  const who = actor || process.env.BOARD_ACTOR || 'service:board-api';
  async function rest(method, pathq, body, extra = {}) {
    const r = await fetch(env.url + '/rest/v1/' + pathq, {
      method,
      headers: { apikey: env.key, Authorization: 'Bearer ' + env.key, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${pathq.split('?')[0]} -> ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  const rows = async t => (await rest('GET', `${t}?select=id,data&order=id`)).map(r => ({ id: r.id, ...(r.data || {}) }));
  const merge = (t, id, patch) => rest('POST', 'rpc/merge_doc', { tbl: t, doc_id: id, patch, actor: who });
  const upsert = (t, id, data) => rest('POST', `${t}?on_conflict=id`, [{ id, data }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
  return {
    actor: who,
    rows,
    /** Every event, with its promoter contacts merged back in as plain fields. */
    async events() {
      const [ev, contacts] = await Promise.all([rows('events'), rows('event_contacts')]);
      const byId = new Map(contacts.map(c => [c.id, c]));
      return ev.map(e => {
        const c = byId.get(e.id) || {};
        const out = { ...e };
        for (const k of PRIVATE) if (c[k] != null) out[k] = c[k];
        return out;
      });
    },
    async settings() { return (await rows('settings')).find(s => s.id === 'division') || {}; },
    /** Merge a patch into an event; contact fields go to event_contacts. */
    async patchEvent(id, patch) {
      const { pub, priv } = splitPriv(patch);
      if (Object.keys(priv).length) await merge('event_contacts', id, priv);
      if (Object.keys(pub).length) await merge('events', id, pub);
    },
    /** One slot of a show, written only if it still holds `seen` ({ rep, ft }): set_slot in supabase/schema.sql (stage 3,
     *  2026-10-27; the coverage agent's move). Answers { ok: true, slot } or { ok: false, why: 'changed' (with `now`, what
     *  the slot holds) | 'gone' | 'bad' }; a stale slot is an answer, never a throw. The changelog says who (`actor`). */
    async setSlot(id, booth, shift, day, seen, value) {
      return rest('POST', 'rpc/set_slot', { p_event: id, p_booth: booth, p_shift: shift, p_day: day, p_seen: seen, p_value: value, p_actor: who });
    },
    /** Create an event document (and its contacts row when it carries any). */
    async createEvent(id, doc) {
      const { pub, priv } = splitPriv(doc);
      await upsert('events', id, pub);
      if (Object.values(priv).some(v => v != null && String(v).trim() !== '')) await upsert('event_contacts', id, priv);
    },
    async mergeSettings(patch) { await merge('settings', 'division', patch); },
    /** One row read fresh, or null (the coverage agent reads a show or a mall again right before it moves a shift). */
    async row(t, id) {
      const r = await rest('GET', `${t}?select=id,data,updated_at&id=eq.${encodeURIComponent(id)}`);
      return r[0] ? { id: r[0].id, updatedAt: r[0].updated_at, ...(r[0].data || {}) } : null;
    },
    /** Merge a patch into a mall's row; send the whole `shifts` map, as the page does, so other days survive. */
    async patchKiosk(id, patch) { await merge('kiosks', id, patch); },
    /** Reps' coverage requests (schema.sql `coverage`; rsd-shift-picking's coverage agent is the only writer past "new"). */
    coverage: {
      all: () => rows('coverage'),
      byStatus: sts => rest('GET', `coverage?select=id,data&data->>status=in.(${sts.join(',')})&order=id`).then(rs => rs.map(r => ({ id: r.id, ...(r.data || {}) }))),
      patch: (id, patch) => merge('coverage', id, patch),
    },
    /** sheet_syncs: the page's "Sync from the Sheet" requests and every sync run's result (schema.sql). */
    syncs: {
      open: () => rest('GET', 'sheet_syncs?select=id,requested_by,requested_at,status,started_at&status=in.(pending,running)&order=id'),
      byIds: ids => rest('GET', `sheet_syncs?select=id,status&id=in.(${ids.join(',')})&order=id`),
      /** The run that finished last, whatever started it (the button, the hourly sync, Wednesday's). */
      last: async () => (await rest('GET', 'sheet_syncs?select=id,status,finished_at,requested_by&status=in.(done,stopped,failed)&order=finished_at.desc.nullslast&limit=1'))[0] || null,
      add: row => rest('POST', 'sheet_syncs', [row], { Prefer: 'return=minimal' }),
      /** Update the rows with these ids that are still in `from`; returns the rows it changed. */
      move: (ids, from, patch) => rest('PATCH', `sheet_syncs?id=in.(${ids.join(',')})&status=eq.${from}`, patch, { Prefer: 'return=representation' }),
    },
  };
}
