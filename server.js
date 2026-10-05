// Recruitment & Sourcing Sniper — MVP to evaluate Reqbeat.
// Trigger (Reqbeat search) -> enrichment -> recruiter matching -> SIMULATED outreach.
// Nothing is ever sent: emails are drafted and shown in the dashboard only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const API = 'https://api.reqbeat.com';
const KEY = (process.env.REQBEAT_API_KEY || '').trim();
const PORT = Number(process.env.PORT) || 4321;
const SANDBOX_MAX_LIMIT = 25;
const CACHE = path.join(__dirname, 'data', 'last-run.json');

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reqbeat(pathname, params = {}, stats) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  stats.calls++;
  const res = await fetch(url, { headers: KEY ? { 'X-API-Key': KEY } : {}, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const detail = typeof body === 'object' ? JSON.stringify(body.detail ?? body) : String(body);
    const err = new Error(`${res.status} ${pathname}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function searchReqs(role, geo, since, limit, stats) {
  if (KEY) return reqbeat('/v1/reqs/search', { role, geo, since, limit, exclude_agencies: true }, stats);
  // Keyless sandbox: same read, smaller page, no pagination, no agency filter.
  return reqbeat('/v1/sandbox/reqs/search', { role, geo, since, limit: Math.min(limit, SANDBOX_MAX_LIMIT) }, stats);
}

const nameFromDomain = (d) => {
  if (!d) return 'Unknown company';
  const base = d.replace(/^www\./, '').split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
};

const val = (p) => (p && typeof p === 'object' && 'value' in p ? p.value : p);

function matchRecruiters(signal, recruiters) {
  const title = signal.title.toLowerCase();
  return recruiters
    .map((r) => {
      let score = 0;
      const reasons = [];
      if (r.domains.includes(signal.domain)) { score += 50; reasons.push(`specialises in ${signal.domain.toUpperCase()} roles`); }
      if (r.countries.includes(signal.country)) { score += 30; reasons.push(`covers ${signal.country}`); }
      else if (r.countries.includes('*')) { score += 15; reasons.push('works Europe-wide'); }
      const hits = r.keywords.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(title));
      if (hits.length) { score += Math.min(hits.length * 5, 15); reasons.push(`title keywords: ${hits.join(', ')}`); }
      const level = r.seniority.find((s) => title.includes(s));
      if (level) { score += 5; reasons.push(`places ${level}-level`); }
      return { id: r.id, name: r.name, firm: r.firm, email: r.email, score, reasons };
    })
    .filter((m) => m.score >= 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function ageLabel(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function draftEmail(signal, recruiter, sender) {
  const first = recruiter.name.split(' ')[0];
  const p = signal.pulse;
  const pulseLine = p.openReqs
    ? ` They currently have ${p.openReqs} open reqs${p.direction === 'up' ? ' and hiring is trending up' : ''}${p.newRoles30d ? ` (${p.newRoles30d} new roles in the last 30 days)` : ''}.`
    : '';
  return {
    to: `${recruiter.name} <${recruiter.email}>`,
    subject: `${signal.company} just opened ${/^[aeiou]/i.test(signal.roleLabel) ? 'an' : 'a'} ${signal.roleLabel} req (${signal.country})`,
    body:
      `Hey ${first},\n\n` +
      `Saw that ${signal.company} opened a req for "${signal.title}" in ${signal.country} — first seen ${ageLabel(signal.firstSeen)} on ${signal.boards.join(', ') || 'their careers page'}.${pulseLine}\n\n` +
      `Do you have candidate bandwidth for this role, or are you looking to backfill it?\n\n` +
      `— ${sender}`,
  };
}

async function runPipeline() {
  const config = readJson('config.json');
  const recruiters = readJson('data/recruiters.json');
  const stats = { calls: 0 };
  const errors = [];
  const since = new Date(Date.now() - config.lookbackDays * 864e5).toISOString();
  const byKey = new Map();
  let asOf = null;
  let halted = false;

  // 1. Trigger: who opened a matching req since the lookback cutoff.
  for (const role of config.roles) {
    for (const country of config.countries) {
      if (halted) break;
      try {
        const page = await searchReqs(role.query, country, since, config.perQueryLimit, stats);
        asOf = page.as_of || asOf;
        for (const c of page.companies || []) {
          for (const r of c.matched_reqs || []) {
            if (!r.first_seen || new Date(r.first_seen) < new Date(since)) continue;
            const title = r.raw_title || r.title || role.label;
            const key = `${c.company_id}|${title}`;
            if (byKey.has(key)) continue;
            byKey.set(key, {
              id: key,
              companyId: c.company_id,
              domainName: c.company_domain,
              company: nameFromDomain(c.company_domain),
              title,
              roleLabel: role.label,
              domain: role.domain,
              country: r.country || country,
              firstSeen: r.first_seen,
              boards: r.boards || [],
              pulse: {
                openReqs: val(c.pulse?.open_req_count),
                newRoles30d: val(c.pulse?.new_roles_30d),
                direction: val(c.pulse?.direction),
                surge: !!val(c.pulse?.is_surge),
              },
            });
          }
        }
      } catch (e) {
        errors.push(`${role.query} / ${country}: ${e.message}`);
        if (e.status === 401 || e.status === 403 || e.status === 429) halted = true;
      }
      if (!KEY) await sleep(250); // sandbox is rate-limited per IP
    }
  }

  const signals = [...byKey.values()].sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

  // 2. Enrichment: real company names for the freshest companies (keyed mode only; each call is metered).
  if (KEY && !halted) {
    const ids = [...new Set(signals.map((s) => s.companyId))].slice(0, config.enrichLimit);
    for (const id of ids) {
      try {
        const e = await reqbeat(`/v1/companies/${id}/enrichment`, {}, stats);
        for (const s of signals) if (s.companyId === id) { if (e.name) s.company = e.name; s.hqCountry = e.hq_country; s.enriched = true; }
      } catch (e) {
        errors.push(`enrichment ${id}: ${e.message}`);
        if (e.status === 429 || e.status === 403) break;
      }
      await sleep(200); // pace the burst; back-to-back lookups trip Reqbeat's rate limit
    }
  }

  // 3 + 4. Match each signal to recruiters and draft the (simulated) outreach.
  for (const s of signals) {
    s.matches = matchRecruiters(s, recruiters);
    s.email = s.matches[0] ? draftEmail(s, s.matches[0], config.sender) : null;
    // Reqbeat exposes no people data; a real build would resolve this via a B2B contact provider.
    s.hiringContact = { simulated: true, label: `Head of Talent @ ${s.domainName || s.company}` };
  }

  let account = null;
  let usage = null;
  if (KEY) {
    try { account = await reqbeat('/v1/whoami', {}, stats); } catch (e) { errors.push(`whoami: ${e.message}`); }
    try { usage = await reqbeat('/v1/usage', {}, stats); } catch (e) { errors.push(`usage: ${e.message}`); }
  }

  const run = {
    ranAt: new Date().toISOString(),
    mode: KEY ? 'live' : 'sandbox',
    since,
    dataAsOf: asOf,
    apiCalls: stats.calls,
    queries: config.roles.length * config.countries.length,
    config: { roles: config.roles.map((r) => r.label), countries: config.countries, lookbackDays: config.lookbackDays },
    account,
    usage: usage && { calls: usage.calls },
    recruiterCount: recruiters.length,
    errors,
    signals,
  };
  fs.writeFileSync(CACHE, JSON.stringify(run, null, 2));
  return run;
}

let running = null;
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

http
  .createServer(async (req, res) => {
    try {
      if (req.url === '/api/run' && req.method === 'POST') {
        running ??= runPipeline().finally(() => { running = null; });
        return send(res, 200, await running);
      }
      if (req.url === '/api/last') {
        return send(res, 200, fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { empty: true, mode: KEY ? 'live' : 'sandbox' });
      }
      if (req.url === '/guide' || req.url === '/guide.html') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'guide.html')), 'text/html; charset=utf-8');
      }
      if (req.url === '/' || req.url === '/index.html') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  })
  .listen(PORT, () => console.log(`Sourcing Sniper on http://localhost:${PORT}  (Reqbeat mode: ${KEY ? 'live key' : 'sandbox, no key'})`));
