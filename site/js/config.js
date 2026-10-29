// Where the Cloudflare Worker lives. Leave empty to run in local-only mode
// (state is shared between tabs of one browser — handy for testing).
// Examples: 'https://fantasy-poker-api.<your-subdomain>.workers.dev' or 'https://poker-api.eliasro.de'
export const API_BASE = 'https://fantasy-poker-api.eliasrode.workers.dev';

// How often viewers check for changes (ms).
export const POLL_MS = 1200;
