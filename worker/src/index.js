// Fantasy Poker shared-state API: the one table is a JSON blob kept in a Durable Object,
// so every viewer reads the latest version and writes can't silently overwrite each other.
//   GET /table   -> blob (ETag; supports If-None-Match -> 304)
//   PUT /table   -> write; If-Match: <etag> for safe updates, If-None-Match: * to create
// Concurrent writers get 412 and the client re-syncs.

const MAX_BYTES = 1_000_000;

const strip = (etag) => etag.replace(/^W\//, '').replace(/"/g, '').trim();
const etagOf = (version) => `"v${version}"`;

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (allowed.includes('*') ? '*' : origin) : 'null',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

// One instance holds the table. A Durable Object handles one request at a time,
// so the version check and the write below can't interleave with another write.
export class Table {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS blob (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, body TEXT NOT NULL)');
  }

  read() {
    return this.sql.exec('SELECT version, body FROM blob WHERE id = 1').toArray()[0] || null;
  }

  async fetch(request) {
    const cur = this.read();

    if (request.method === 'GET') {
      if (!cur) return json({ error: 'no table yet' }, 404);
      const etag = etagOf(cur.version);
      const inm = request.headers.get('If-None-Match');
      if (inm && strip(inm) === strip(etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(cur.body, { headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'no-store' } });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return json({ error: 'too large' }, 413);
      try { JSON.parse(body); } catch { return json({ error: 'invalid json' }, 400); }

      const ifMatch = request.headers.get('If-Match');
      if (ifMatch && (!cur || strip(ifMatch) !== strip(etagOf(cur.version)))) return json({ error: 'conflict' }, 412);
      if (!ifMatch && request.headers.get('If-None-Match') === '*' && cur) return json({ error: 'exists' }, 412);

      const version = (cur?.version || 0) + 1;
      this.sql.exec('INSERT OR REPLACE INTO blob (id, version, body) VALUES (1, ?, ?)', version, body);
      return json({ ok: true }, 200, { ETag: etagOf(version) });
    }

    return json({ error: 'method not allowed' }, 405);
  }
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    if (url.pathname === '/') return json({ ok: true, service: 'fantasy-poker' }, 200, headers);
    if (url.pathname !== '/table') return json({ error: 'not found' }, 404, headers);

    const stub = env.TABLE.get(env.TABLE.idFromName('main'));
    const res = await stub.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
    return out;
  },
};
