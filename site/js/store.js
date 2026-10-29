// The shared blob. Remote = Cloudflare Worker + Durable Object; Local = localStorage shared across tabs.
import { API_BASE } from './config.js';

export class ConflictError extends Error {}

class RemoteStore {
  constructor(base) {
    this.url = `${base.replace(/\/$/, '')}/table`;
    this.etag = null;
    this.label = 'online';
  }

  async load() {
    const r = await fetch(this.url, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    this.etag = r.headers.get('ETag');
    return r.json();
  }

  // Resolves to the new state, or null when nothing changed.
  async poll() {
    const headers = this.etag ? { 'If-None-Match': this.etag } : {};
    const r = await fetch(this.url, { cache: 'no-store', headers });
    if (r.status === 304) return null;
    if (!r.ok) throw new Error(`poll failed (${r.status})`);
    const etag = r.headers.get('ETag');
    if (etag && etag === this.etag) return null;
    this.etag = etag;
    return r.json();
  }

  async save(state, { create = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (create) headers['If-None-Match'] = '*';
    else if (this.etag) headers['If-Match'] = this.etag;
    const r = await fetch(this.url, { method: 'PUT', headers, body: JSON.stringify(state) });
    if (r.status === 412) throw new ConflictError('conflict');
    if (!r.ok) throw new Error(`save failed (${r.status})`);
    this.etag = r.headers.get('ETag');
  }
}

class LocalStore {
  constructor() {
    this.key = 'fantasy-poker:table';
    this.etag = null;
    this.label = 'local only';
  }

  read() {
    try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { return null; }
  }

  async load() {
    const rec = this.read();
    if (!rec) return null;
    this.etag = rec.etag;
    return rec.state;
  }

  async poll() {
    const rec = this.read();
    if (!rec || rec.etag === this.etag) return null;
    this.etag = rec.etag;
    return rec.state;
  }

  async save(state, { create = false } = {}) {
    const rec = this.read();
    if (create ? rec : rec && rec.etag !== this.etag) throw new ConflictError('conflict');
    this.etag = Math.random().toString(36).slice(2);
    localStorage.setItem(this.key, JSON.stringify({ etag: this.etag, state }));
  }
}

export function makeStore() {
  const forceLocal = new URLSearchParams(location.search).has('local');
  return API_BASE && !forceLocal ? new RemoteStore(API_BASE) : new LocalStore();
}
