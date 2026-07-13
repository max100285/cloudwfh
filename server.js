'use strict';
const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const compression = require('compression');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── SITE CONFIG ───────────────────────────────────────────
const SITE_NAME   = process.env.SITE_NAME   || 'CloudWFH';
const SITE_DOMAIN = process.env.SITE_DOMAIN || process.env.SITE_URL || 'localhost:8080';
const SITE_URL    = `https://${SITE_DOMAIN}`;
const TAGLINE     = 'Your gateway to work-from-home careers — updated daily';
const META_DESC   = 'Find thousands of work-from-home jobs on CloudWFH. Browse WFH roles across every industry — free to apply, no sign-up needed.';
const LOGO_LETTER = SITE_NAME.slice(0, 2).toUpperCase();

// ── VPS API CONFIG ────────────────────────────────────────
const API_URL = (process.env.API_URL || '').replace(/\/$/, '');
const API_KEY  = process.env.API_SECRET || process.env.API_KEY || '';
const API_HDR  = { 'X-Api-Key': API_KEY, 'Accept': 'application/json' };

if (!API_URL) console.warn('[WARN] API_URL env var not set');
if (!API_KEY)  console.warn('[WARN] API_SECRET (or API_KEY) env var not set');

// ── CATEGORIES ────────────────────────────────────────────
const CATEGORIES = {
    'remote-customer-support-jobs':   'customer support',
    'remote-marketing-jobs':          'marketing',
    'remote-sales-jobs':              'sales',
    'remote-accounting-jobs':         'accounting',
    'remote-project-management-jobs': 'project management',
    'remote-healthcare-jobs':         'healthcare',
    'remote-writing-jobs':            'writing',
    'remote-human-resources-jobs':    'human resources',
    'remote-design-jobs':             'design',
    'remote-operations-jobs':         'operations',
    'remote-work-from-home-jobs':     'work from home',
    'remote-entry-level-jobs':        'entry level remote',
    'remote-part-time-jobs':          'part time remote',
    'remote-no-experience-jobs':      'no experience remote',
    'remote-full-time-jobs':          'remote full time',
    'remote-freelance-jobs':          'freelance remote',
    'remote-data-entry-jobs':         'data entry remote',
};

const SITEMAP_SIZE = 12500;
const APPLY_DOMAIN = 'https://ihire.allboardsolutions.in';

// ── ASSETS ────────────────────────────────────────────────
const STYLES = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const FAVICON = 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'><rect width=\'32\' height=\'32\' rx=\'8\' fill=\'%230D9488\'/><path d=\'M25 21H9a5 5 0 010-10c.3 0 .6.03.88.08A7 7 0 0123 16.5 4.5 4.5 0 0125 21z\' fill=\'white\'/><path d=\'M8.5 21h16a3.5 3.5 0 000-7c-.26 0-.52.03-.76.08A6 6 0 005 16.5 3.5 3.5 0 008.5 21z\' fill=\'white\' opacity=\'.7\'/></svg>';

// ── SELF-HOSTED FONTS ─────────────────────────────────────
let _fontCss = '';
const _fontFiles = new Map();

async function loadFonts() {
    try {
        const cssRes = await fetch(
            'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }
        );
        let css = await cssRes.text();
        const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
        await Promise.all(urls.map(async url => {
            const fname = 'i' + Buffer.from(url).toString('base64url').slice(-12) + '.woff2';
            const buf   = Buffer.from(await fetch(url).then(r => r.arrayBuffer()));
            _fontFiles.set(fname, buf);
            css = css.replace(url, `/font/${fname}`);
        }));
        _fontCss = css;
        console.log(`[OK] Fonts self-hosted (${_fontFiles.size} files)`);
    } catch (e) {
        console.warn('[WARN] Font self-hosting failed, falling back to Google Fonts:', e.message);
        _fontCss = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');`;
    }
}

// ── IN-PROCESS RESPONSE CACHE ─────────────────────────────
const TTL_LIST  = 10 * 60 * 1000;
const TTL_JOB   = 30 * 60 * 1000;
const MAX_CACHE = 60;

const _apiCache   = new Map();
const _refreshing = new Set();

function _cacheEntry(key) { return _apiCache.get(key) || null; }
function _cacheSet(key, data, ttl) {
    if (_apiCache.size >= MAX_CACHE) { _apiCache.delete(_apiCache.keys().next().value); }
    _apiCache.set(key, { data, expires: Date.now() + ttl, ttl });
}
setInterval(() => { const n = Date.now(); for (const [k,v] of _apiCache) if (n > v.expires + v.ttl) _apiCache.delete(k); }, 5 * 60 * 1000);

// Stale-while-revalidate: return cached data instantly (even if stale) and
// refresh in the background so the *next* request gets fresh data.
function _fetchWithTimeout(url, opts, ms = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function apiFetch(apiPath, ttl = TTL_LIST) {
    const entry = _cacheEntry(apiPath);
    if (entry) {
        if (Date.now() <= entry.expires) return entry.data;   // fresh
        _bgRefresh(apiPath, ttl);                              // stale → serve immediately, refresh bg
        return entry.data;
    }
    // cold miss: must wait
    const res = await _fetchWithTimeout(`${API_URL}${apiPath}`, { headers: API_HDR });
    if (!res.ok) throw new Error(`API ${apiPath} → HTTP ${res.status}`);
    const data = await res.json();
    _cacheSet(apiPath, data, ttl);
    return data;
}

function _bgRefresh(apiPath, ttl) {
    if (_refreshing.has(apiPath)) return;
    _refreshing.add(apiPath);
    _fetchWithTimeout(`${API_URL}${apiPath}`, { headers: API_HDR })
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(data => _cacheSet(apiPath, data, ttl))
        .catch(() => {})
        .finally(() => _refreshing.delete(apiPath));
}

function normaliseJob(j) {
    return {
        id:           j.ID   || j.id   || '',
        slug:         j.slug          || '',
        post_title:   j.post_title    || '',
        post_date:    j.post_date     || '',
        post_content: j.post_content  || '',
        permalink:    j.permalink     || '',
    };
}

async function apiGetJobs({ page = 1, search = '' } = {}) {
    const q = new URLSearchParams({ page });
    if (search) q.set('search', search);
    const data = await apiFetch(`/api/jobs?${q}`, TTL_LIST);
    return {
        jobs:       (data.jobs || []).map(normaliseJob),
        pagination: data.pagination || { currentPage: page, totalPages: 1, totalJobs: 0, hasNext: false, hasPrev: false },
    };
}

// Both calls cached — slug lookup for job content (30 min SWR), id lookup for
// randomJobs (2 min SWR). Eliminates the serial uncached round-trips that caused
// ~10s TTFB on job detail pages.
async function apiGetJobWithRelated(slug) {
    let job = null;
    try {
        const data = await apiFetch(`/api/jobs/${encodeURIComponent(slug)}`, TTL_JOB);
        job = data.job ? normaliseJob(data.job) : null;
    } catch { return { job: null, randomJobs: [] }; }
    if (!job) return { job: null, randomJobs: [] };

    try {
        const data = await apiFetch(`/api/jobs/${encodeURIComponent(job.id)}`, 2 * 60 * 1000);
        return { job, randomJobs: (data.randomJobs || []).map(normaliseJob) };
    } catch { return { job, randomJobs: [] }; }
}

// ── CRC32 (deterministic dates per slug) ─────────────────
const _t = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _t[i] = c; }
const crc32 = s => { let c = 0xFFFFFFFF; for (let i = 0; i < s.length; i++) c = _t[(c ^ s.charCodeAt(i)) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const dayOfYear = () => { const n = new Date(); return Math.floor((n - new Date(n.getFullYear(), 0, 0)) / 86400000); };
const jobPostedDate   = slug => { const d = new Date(); d.setDate(d.getDate() - (crc32(slug) + Math.floor(dayOfYear() / 2)) % 7); return d.toISOString().split('T')[0]; };
const jobValidThrough = slug => { const d = new Date(); d.setDate(d.getDate() + (crc32(slug + 'exp') + Math.floor(dayOfYear() / 2)) % 31 + 15); return d.toISOString().split('T')[0]; };
const JOB_COUNTRIES   = ['US','IN','PH','GB','CA','NG','MY','ZA','AU','KE','AE','BD','SG','SA','BR','JP','DE','PK','ID','NL','SE','KR','MX','FR','ES','IT','CH','DK','NO','IE','PL','TH','VN','QA','AR','CL','CO','PT','RO','NZ','EG','GH','TR','IL','HK','TW','CZ','HU','AT','BE','FI','GR','RS','HR','SK','BG','LT','LV','EE','MT','CY'];
const jobCountry      = slug => JOB_COUNTRIES[crc32(slug) % JOB_COUNTRIES.length];

// ── CONTENT HELPERS ───────────────────────────────────────
const escHtml    = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const safeJson   = v => JSON.stringify(v).replace(/<\//g,'<\\/');
const cleanTitle = s => (s || '').replace(/\*\*/g,'').trim();

function applyUrl(permalink) {
    const p = (permalink || '').replace(/^https?:\/\/[^\/]+/, '');
    return p ? `${APPLY_DOMAIN}${p}` : APPLY_DOMAIN;
}

function sanitize(raw) {
    if (!raw) return '';
    let s = raw;
    // Decode entities FIRST - turns &lt;div class="..."&gt; into real tags that can be stripped
    const ent = { nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",hellip:'\u2026',mdash:'\u2014',ndash:'\u2013',bull:'\u2022',rsquo:'\u2019',lsquo:'\u2018',ldquo:'\u201C',rdquo:'\u201D' };
    const decode = str => str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, r) => { if (r[0]==='#') { const c=r[1]==='x'?parseInt(r.slice(2),16):parseInt(r.slice(1),10); return Number.isFinite(c)?String.fromCodePoint(c):''; } return ent[r.toLowerCase()]??m; });
    // Two decode passes to handle double-encoded content (&amp;lt; -> &lt; -> <)
    s = decode(decode(s));
    // Strip anchor tags and their inner text entirely
    s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '');
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/\[\s*\/?\s*(?:ad|ads|adsense|banner)[\w\s-]*\]/gi, '');
    s = s.replace(/<(script|style|iframe|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    // Convert <p> blocks to newlines so formatContent produces proper paragraphs
    s = s.replace(/<\/p\s*>/gi, '\n\n');
    s = s.replace(/<p\b[^>]*>/gi, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    // Strip ALL tag attributes (leaves bare tags like <div>, <h4>, <ul>)
    s = s.replace(/<\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, '<$1>');
    // Unwrap structural wrapper tags (removes the tag but KEEPS its content)
    const unwrap = /^<\/?(span|div|font|center|section|article|header|footer|figure|table|thead|tbody|tr|td|th|svg|path|img|nav|main|aside)>$/i;
    s = s.replace(/<[^>]+>/g, m => unwrap.test(m) ? '' : m);
    // Remove everything except safe inline/block elements
    const allowed = /^<\/?(ul|ol|li|h[1-6]|strong|b|em|i|blockquote|code|pre)>$/i;
    s = s.replace(/<[^>]+>/g, m => allowed.test(m) ? m : '');
    // Re-encode bare & from entity decoding to keep valid HTML
    s = s.replace(/&(?![a-zA-Z#][a-zA-Z0-9#]*;)/g, '&amp;');
    return s.replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function formatContent(raw) {
    let s = sanitize(raw);
    if (!s) return '';
    s = s.replace(/\*\*([^*\n]{1,90}?)\*\*/g, (_, t) => `\n\n\xB6H\xB6${t.trim()}\xB6/H\xB6\n\n`);
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
    let html = '', inList = false, para = [];
    const flush    = () => { if (para.length) { html += `<p>${para.join(' ').trim()}</p>\n`; para = []; } };
    const closeList= () => { if (inList) { html += '</ul>\n'; inList = false; } };
    for (const line of lines) {
        if (/^[•*-]\s/.test(line))                               { flush(); if (!inList) { html += '<ul>\n'; inList = true; } html += `<li>${line.replace(/^[•*-]\s+/,'')}</li>\n`; }
        else if (line.startsWith('\xB6H\xB6') && line.endsWith('\xB6/H\xB6')) { flush(); closeList(); html += `<h2>${line.slice(3,-5)}</h2>\n`; }
        else                                                       { closeList(); para.push(line); }
    }
    flush(); closeList();
    return html;
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

// ── SITEMAP CACHE ─────────────────────────────────────────
// Flat "slug\tdate" strings use ~140MB vs ~280MB for {slug,post_date} objects
let _sitemapLines = [];

async function buildSitemapCache() {
    try {
        const res = await _fetchWithTimeout(`${API_URL}/api/sitemap-jobs`, { headers: API_HDR }, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        _sitemapLines = []; // release old data so GC can reclaim before we allocate new

        const newLines = [];
        const decoder = new TextDecoder();
        const TAIL = 512;
        let buf = '';
        let pSlug = null, pDate = null;

        const extract = (text) => {
            const re = /"slug":"([^"\\]*)"|"post_date":"([^"\\]*)"/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                if (m[1] !== undefined) {
                    if (pDate !== null) { newLines.push(m[1] + '\t' + pDate); pDate = null; }
                    else pSlug = m[1];
                } else {
                    if (pSlug !== null) { newLines.push(pSlug + '\t' + m[2]); pSlug = null; }
                    else pDate = m[2];
                }
            }
        };

        for await (const rawChunk of res.body) {
            buf += decoder.decode(rawChunk, { stream: true });
            if (buf.length <= TAIL) continue;
            extract(buf.slice(0, buf.length - TAIL));
            buf = buf.slice(buf.length - TAIL);
        }
        extract(buf);

        _sitemapLines = newLines;
        console.log(`[sitemap] ${_sitemapLines.length} jobs cached`);
    } catch (e) {
        console.warn('[WARN] Sitemap cache failed:', e.message);
    }
}

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(compression());
app.disable('x-powered-by');

// ── AI BOT BLOCKING ───────────────────────────────────────
const BLOCKED_BOTS = [
    'AddSearchBot','AgentTimes','AI2Bot','AI2Bot-DeepResearchEval','Ai2Bot-Dolma',
    'aiHitBot','amazon-kendra','Amazonbot','AmazonBuyForMe','Amzn-SearchBot',
    'Amzn-User','Andibot','Anomura','anthropic-ai','ApifyBot',
    'ApifyWebsiteContentCrawler','Applebot','Applebot-Extended','Aranet-SearchBot',
    'atlassian-bot','Awario','AzureAI-SearchBot','bedrockbot','bigsur.ai',
    'Bravebot','Brightbot','Brightbot 1.0','BuddyBot','Bytespider',
    'CCBot','Channel3Bot','ChatGLM-Spider','ChatGPT Agent','ChatGPT-User',
    'Claude-Code','Claude-SearchBot','Claude-User','Claude-Web','ClaudeBot',
    'Cloudflare-AutoRAG','CloudVertexBot','Code','cohere-ai','cohere-training-data-crawler',
    'Cotoyogi','CragCrawler','Crawl4AI','Crawlspace','Cursor',
    'Datenbank Crawler','DeepSeekBot','Devin','Diffbot','DuckAssistBot',
    'Echobot Bot','EchoboxBot','ExaBot','FacebookBot','facebookexternalhit',
    'Factset_spyderbot','FirecrawlAgent','FriendlyCrawler','GeistHaus-PageFetcher',
    'Gemini-Deep-Research','Google-Agent','Google-CloudVertexBot','Google-Extended',
    'Google-Firebase','Google-Gemini-CLI','Google-NotebookLM','GoogleAgent-Mariner',
    'GoogleAgent-URLContext','GoogleOther','GoogleOther-Image','GoogleOther-Video',
    'GPTBot','HenkBot','iAskBot','iaskspider','IbouBot','ICC-Crawler',
    'ImagesiftBot','imageSpider','img2dataset','ISSCyberRiskCrawler','kagi-fetcher',
    'Kangaroo Bot','Kimi-User','KlaviyoAIBot','KunatoCrawler',
    'laion-huggingface-processor','LAIONDownloader','LCC','LinerBot','Linguee Bot',
    'LinkupBot','Manus-User','meta-externalagent','Meta-ExternalAgent',
    'meta-externalfetcher','Meta-ExternalFetcher','meta-webindexer','MistralAI-User',
    'MistralAI-User/1.0','MyCentralAIScraperBot','NagetBot','netEstate Imprint Crawler',
    'newsai','NotebookLM','NovaAct','OAI-SearchBot','omgili','omgilibot',
    'OpenAI','opencode','Operator','PanguBot','Panscient','panscient.com',
    'Perplexity-User','PerplexityBot','PetalBot','PhindBot','Poggio-Citations',
    'Poseidon Research Crawler','QualifiedBot','Querit-SearchBot','QueritBot',
    'QuillBot','quillbot.com','SBIntuitionsBot','Scrapy','SemrushBot-OCOB',
    'SemrushBot-SWA','Shap-User','ShapBot','Sidetrade indexer bot','Spider',
    'TavilyBot','Terra Cotta','TerraCotta','Thinkbot','TikTokSpider','Timpibot',
    'Trae','TwinAgent','UseAI','VelenPublicWebCrawler','WARDBot','Webzio-Extended',
    'webzio-extended','wpbot','WRTNBot','YaK','YandexAdditional','YandexAdditionalBot',
    'YouBot','ZanistaBot',
];
const AI_BOTS = new RegExp(BLOCKED_BOTS.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
app.use((req, res, next) => {
    if (req.path.startsWith('/google') && req.path.endsWith('.html')) return next();
    const ua = req.headers['user-agent'] || '';
    if (AI_BOTS.test(ua)) return res.status(403).end();
    next();
});

// ── HTML PARTIALS ─────────────────────────────────────────
const jobCard = j => `
<a href="/remote-jobs/${j.slug}" class="job-card">
  <div class="job-card-body">
    <h2 class="job-title">${escHtml(cleanTitle(j.post_title))}</h2>
    <div class="job-meta"><span>WFH</span><span>Full-time</span></div>
  </div>
  <span class="job-card-arrow">&#8594;</span>
</a>`;

const jobTile = j => `
<a href="/remote-jobs/${j.slug}" class="job-tile">
  <h2 class="job-title">${escHtml(cleanTitle(j.post_title))}</h2>
  <div class="job-meta"><span>WFH</span><span>Full-time</span></div>
</a>`;

const nav = () => `
<nav class="top-nav"><div class="container">
  <a href="/" class="logo">
    <span class="logo-mark">${LOGO_LETTER}</span>
    <span>${SITE_NAME}</span>
  </a>
  <div class="nav-links">
    <a href="/" class="nav-link">All WFH Jobs</a>
    <a href="/remote-full-time-jobs" class="nav-link">Full-time</a>
    <a href="/remote-entry-level-jobs" class="nav-link">Entry Level</a>
    <a href="/remote-work-from-home-jobs" class="nav-link">WFH</a>
    <span class="nav-badge">80K+ Roles</span>
  </div>
</div></nav>`;

const footer = () => `
<footer class="site-footer"><div class="container">
  <div class="footer-grid">
    <div class="footer-brand">
      <div class="footer-logo">
        <span class="logo-mark">${LOGO_LETTER}</span>
        <span>${SITE_NAME}</span>
      </div>
      <p>${TAGLINE}. Browse freely — no account, no fees.</p>
    </div>
    <div class="footer-col">
      <h3>Job Types</h3>
      <div class="footer-col-links">
        <a href="/remote-full-time-jobs"     class="footer-col-link">Full-time Remote</a>
        <a href="/remote-part-time-jobs"     class="footer-col-link">Part-time</a>
        <a href="/remote-entry-level-jobs"   class="footer-col-link">Entry Level</a>
        <a href="/remote-freelance-jobs"     class="footer-col-link">Freelance</a>
        <a href="/remote-no-experience-jobs" class="footer-col-link">No Experience</a>
        <a href="/remote-data-entry-jobs"    class="footer-col-link">Data Entry</a>
      </div>
    </div>
    <div class="footer-col">
      <h3>Industries</h3>
      <div class="footer-col-links">
        <a href="/remote-marketing-jobs"        class="footer-col-link">Marketing</a>
        <a href="/remote-design-jobs"           class="footer-col-link">Design &amp; Creative</a>
        <a href="/remote-writing-jobs"          class="footer-col-link">Writing &amp; Content</a>
        <a href="/remote-customer-support-jobs" class="footer-col-link">Customer Support</a>
        <a href="/remote-healthcare-jobs"       class="footer-col-link">Healthcare</a>
        <a href="/remote-sales-jobs"            class="footer-col-link">Sales</a>
      </div>
    </div>
  </div>
  <div class="footer-base">
    <p>&copy; ${new Date().getFullYear()} ${SITE_NAME}. WFH jobs updated daily.</p>
    <p>Work from home &mdash; every industry, every level.</p>
  </div>
</div></footer>`;

const headTag = (title, desc, canonical, extra = '') => `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escHtml(desc)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title"       content="${escHtml(title)}">
  <meta property="og:description" content="${escHtml(desc)}">
  <meta property="og:url"         content="${canonical}">
  <meta property="og:type"        content="website">
  <meta property="og:site_name"   content="${SITE_NAME}">
  <meta name="twitter:card"        content="summary">
  <meta name="twitter:title"       content="${escHtml(title)}">
  <meta name="twitter:description" content="${escHtml(desc)}">
  <link rel="icon" href="${FAVICON}">
  <link rel="preload" href="/font.css" as="style">
  <link rel="stylesheet" href="/font.css" media="print" onload="this.media='all'">
  <noscript><link rel="stylesheet" href="/font.css"></noscript>
  <meta name="theme-color" content="#0D9488">
  <style>${STYLES}</style>
  ${extra}
</head>`;

// ── INFRA ROUTES ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/font.css', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/css').send(_fontCss);
});

app.get('/font/:file', (req, res) => {
    const buf = _fontFiles.get(req.params.file);
    if (!buf) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('font/woff2').send(buf);
});

app.get('/googlea5509f9e642a23a1.html', (_req, res) => {
    res.type('text/html').send('google-site-verification: googlea5509f9e642a23a1.html');
});

app.get('/google6b031c2b3d6a67cc.html', (_req, res) => {
    res.type('text/html').send('google-site-verification: google6b031c2b3d6a67cc.html');
});

app.get('/robots.txt', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml`);
});

app.get('/sitemap.xml', (_req, res) => {
    const total = Math.ceil(_sitemapLines.length / SITEMAP_SIZE);
    const today = new Date().toISOString().split('T')[0];
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Array.from({ length: total }, (_, i) =>
    `  <sitemap><loc>${SITE_URL}/sitemap-jobs${i+1}.xml</loc><lastmod>${today}</lastmod></sitemap>`
).join('\n')}
</sitemapindex>`);
});

app.get('/sitemap-jobs:num.xml', (req, res) => {
    const n     = parseInt(req.params.num);
    const today = new Date().toISOString().split('T')[0];
    const chunk = _sitemapLines.slice((n-1)*SITEMAP_SIZE, n*SITEMAP_SIZE);
    if (!chunk.length) return res.status(404).send('Not found');
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${chunk.map(line => {
    const tab = line.indexOf('\t');
    const slug = tab >= 0 ? line.slice(0, tab) : line;
    const raw  = tab >= 0 ? line.slice(tab + 1) : '';
    const d    = raw ? new Date(raw).toISOString().split('T')[0] : today;
    return `  <url><loc>${SITE_URL}/remote-jobs/${slug}</loc><lastmod>${d}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
}).join('\n')}
</urlset>`);
});

// ── HOME / LISTING ────────────────────────────────────────
app.get(['/', '/page/:page'], async (req, res) => {
    try {
        const page   = parseInt(req.params.page || req.query.page) || 1;
        const search = (req.query.search || '').trim().toLowerCase();
        const isHome = page === 1 && !search;

        const [data, recent] = await Promise.all([
            apiGetJobs({ page, search }),
            isHome ? apiGetJobs({ page: 1 }) : Promise.resolve(null),
        ]);
        if (isHome) {
            data.jobs = shuffle(data.jobs);
            if (recent) recent.jobs = shuffle(recent.jobs);
        }

        const canonical  = `${SITE_URL}${page > 1 ? `/page/${page}/` : '/'}`;
        const noindexTag = search ? '<meta name="robots" content="noindex,follow">' : '';

        res.set('Cache-Control', search
            ? 'no-store'
            : 'public, max-age=300, stale-while-revalidate=60');
        res.send(`<!DOCTYPE html><html lang="en">
${headTag(`${SITE_NAME} — ${TAGLINE}`, META_DESC, canonical, noindexTag)}
<body>
${nav()}
<header class="hero-section">
  <div class="container">
    <span class="hero-eyebrow">&#9729; Work From Home Jobs</span>
    <h1 class="hero-title">Find Your Perfect<br><em>WFH Career</em></h1>
    <p class="hero-desc">Thousands of work-from-home opportunities across every field — browse freely, apply in one click.</p>
    <form action="/" method="GET" class="search-wrap">
      <input type="search" name="search" placeholder="Job title, skill or keyword…" value="${escHtml(search)}" autocomplete="off" aria-label="Search work from home jobs">
      <button type="submit">Search</button>
    </form>
    <div class="hero-stats">
      <div class="hero-stat"><span class="hero-stat-num">80K+</span><span class="hero-stat-lbl">WFH Roles</span></div>
      <div class="hero-stat"><span class="hero-stat-num">17+</span><span class="hero-stat-lbl">Industries</span></div>
      <div class="hero-stat"><span class="hero-stat-num">$0</span><span class="hero-stat-lbl">Always Free</span></div>
    </div>
  </div>
</header>

<div class="field-nav"><div class="container">
  <span class="field-label">Browse:</span>
  ${Object.entries(CATEGORIES).slice(0,9).map(([slug]) =>
    `<a href="/${slug}" class="field-tag">${slug.replace('remote-','').replace(/-jobs$/,'').replace(/-/g,' ')}</a>`
  ).join('')}
</div></div>

<main class="container">
${data.jobs.length ? `
  <div class="section-intro">
    <h2>${search ? `Results for &ldquo;${escHtml(search)}&rdquo;` : 'Latest WFH Openings'}</h2>
    <span>Page ${page} of ${data.pagination.totalPages}</span>
  </div>
  <div class="jobs-grid-2col">
    ${data.jobs.map(jobTile).join('')}
  </div>
  <div class="pager">
    ${data.pagination.hasPrev?`<a href="/page/${page-1}${search?`?search=${encodeURIComponent(search)}`:''}" class="pager-btn">&larr; Previous</a>`:''}
    ${data.pagination.hasNext?`<a href="/page/${page+1}${search?`?search=${encodeURIComponent(search)}`:''}" class="pager-btn">Next &rarr;</a>`:''}
  </div>
  ${isHome?`
  <div class="explore-section">
    <div class="explore-header">
      <h2>Browse by Category</h2>
      <p>Find WFH roles by industry — discover what matches your skills</p>
    </div>
    <div class="cat-links">
      <a href="/remote-customer-support-jobs"   class="cat-link">Customer Support</a>
      <a href="/remote-marketing-jobs"          class="cat-link">Marketing</a>
      <a href="/remote-accounting-jobs"         class="cat-link">Accounting &amp; Finance</a>
      <a href="/remote-project-management-jobs" class="cat-link">Project Management</a>
      <a href="/remote-healthcare-jobs"         class="cat-link">Healthcare</a>
      <a href="/remote-writing-jobs"            class="cat-link">Writing &amp; Content</a>
      <a href="/remote-human-resources-jobs"    class="cat-link">Human Resources</a>
      <a href="/remote-design-jobs"             class="cat-link">Design &amp; Creative</a>
      <a href="/remote-sales-jobs"              class="cat-link">Sales</a>
      <a href="/remote-operations-jobs"         class="cat-link">Operations</a>
    </div>
  </div>
  <div class="stats-strip">
    <div class="stat-item"><span class="stat-big">80K+</span><span class="stat-sub">WFH Positions</span><span class="stat-desc">Across all fields and experience levels</span></div>
    <div class="stat-item"><span class="stat-big">100%</span><span class="stat-sub">Work From Home</span><span class="stat-desc">No commute, work from any location</span></div>
    <div class="stat-item"><span class="stat-big">$0</span><span class="stat-sub">Free to Use</span><span class="stat-desc">Browse and apply — no sign-up required</span></div>
  </div>
  <div class="popular-tags">
    <span class="popular-label">Popular:</span>
    ${[['remote-full-time-jobs','Full-time Remote'],['remote-entry-level-jobs','Entry Level'],['remote-part-time-jobs','Part-time'],['remote-no-experience-jobs','No Experience'],['remote-freelance-jobs','Freelance'],['remote-data-entry-jobs','Data Entry'],['remote-work-from-home-jobs','Work From Home']].map(([s,l])=>`<a href="/${s}" class="pop-tag">${l}</a>`).join('')}
  </div>
  <div class="block-header"><h2>Freshly Added</h2><p>Just posted today</p></div>
  <div class="jobs-grid-2col">
    ${(recent?.jobs||[]).map(jobTile).join('')}
  </div>`:''}
`:`<div class="empty-state"><p>No positions match your search.</p><a href="/">View all listings &rarr;</a></div>`}
</main>
${footer()}
</body></html>`);
    } catch(e) { console.error(e); res.status(500).send('Server Error'); }
});

// ── CATEGORY PAGES ────────────────────────────────────────
app.get('/:category', async (req, res, next) => {
    const search = CATEGORIES[req.params.category];
    if (!search) return next();

    const page  = parseInt(req.query.page) || 1;
    const label = search.split(' ').map(w => w[0].toUpperCase()+w.slice(1)).join(' ');
    const canonical = `${SITE_URL}/${req.params.category}`;

    try {
        const data = await apiGetJobs({ page, search });
        res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
        res.send(`<!DOCTYPE html><html lang="en">
${headTag(
    `WFH ${label} Jobs — ${data.pagination.totalJobs.toLocaleString()} Openings | ${SITE_NAME}`,
    `Browse ${data.pagination.totalJobs.toLocaleString()} work-from-home ${search} jobs on ${SITE_NAME}. Apply for free — no sign-up required.`,
    canonical
)}
<body>
${nav()}
<header class="cat-hero"><div class="container">
  <h1>Work From Home ${label} Jobs</h1>
  <p>${data.pagination.totalJobs.toLocaleString()} WFH ${search} positions — updated daily.</p>
  <form action="/" method="GET" class="search-wrap" style="max-width:500px">
    <input type="search" name="search" placeholder="Refine by keyword…" autocomplete="off" aria-label="Search jobs">
    <button type="submit">Search</button>
  </form>
</div></header>
<main class="container">
${data.jobs.length?`
  <div class="section-intro">
    <h2>WFH ${label} Roles</h2>
    <span>Page ${page} of ${data.pagination.totalPages}</span>
  </div>
  <div class="jobs-grid">
    ${data.jobs.map(jobCard).join('')}
  </div>
  <div class="pager">
    ${data.pagination.hasPrev?`<a href="/${req.params.category}?page=${page-1}" class="pager-btn">&larr; Previous</a>`:''}
    ${data.pagination.hasNext?`<a href="/${req.params.category}?page=${page+1}" class="pager-btn">Next &rarr;</a>`:''}
  </div>`
:`<div class="empty-state"><p>No positions found in this category.</p><a href="/">Browse all listings &rarr;</a></div>`}
</main>
${footer()}
</body></html>`);
    } catch(e) { console.error(e); res.status(500).send('Server Error'); }
});

// ── JOB DETAIL ────────────────────────────────────────────
app.get('/remote-jobs/:slug', async (req, res) => {
    try {
        const { job, randomJobs } = await apiGetJobWithRelated(req.params.slug);
        if (!job) return res.redirect(301, '/');
        res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=120');
        const content    = formatContent(job.post_content);
        const datePosted = jobPostedDate(job.slug);
        const validThru  = jobValidThrough(job.slug);
        const country    = jobCountry(job.slug);
        const title      = cleanTitle(job.post_title);
        const canonical  = `${SITE_URL}/remote-jobs/${job.slug}`;
        const apply      = applyUrl(job.permalink);

        const schema = safeJson({
            '@context':'https://schema.org','@type':'JobPosting',
            title, datePosted, validThrough: validThru,
            description: job.post_content.replace(/<[^>]+>/g,'').slice(0,500),
            jobLocationType:'TELECOMMUTE', employmentType:'FULL_TIME',
            hiringOrganization:{'@type':'Organization',name:SITE_NAME,sameAs:SITE_URL},
            jobLocation:{'@type':'Place',address:{'@type':'PostalAddress',addressCountry:country}},
            applicantLocationRequirements:{'@type':'Country',name:'Worldwide'},
        });

        const breadcrumb = safeJson({
            '@context':'https://schema.org','@type':'BreadcrumbList',
            itemListElement:[
                {'@type':'ListItem',position:1,name:'Home',item:SITE_URL},
                {'@type':'ListItem',position:2,name:'Remote Jobs',item:`${SITE_URL}/remote-full-time-jobs`},
                {'@type':'ListItem',position:3,name:title,item:canonical},
            ],
        });

        res.send(`<!DOCTYPE html><html lang="en">
${headTag(
    `${title} | ${SITE_NAME}`,
    `Apply for ${title} — a work-from-home role on ${SITE_NAME}. WFH position, zero commute required.`,
    canonical,
    `<script type="application/ld+json">${schema}</script><script type="application/ld+json">${breadcrumb}</script>`
)}
<body>
${nav()}
<main class="container">
  <div class="job-detail-wrap">
    <a href="/" class="back-link">&larr; Back to all WFH jobs</a>
    <div class="detail-layout">
      <div class="detail-card">
        <h1>${escHtml(title)}</h1>
        <div class="detail-meta">
          <span>WFH</span><span>Full-time</span><span>${country}</span><span>Posted ${datePosted}</span>
        </div>
        <div class="job-content">${content}</div>
        <a href="${escHtml(apply)}" target="_blank" rel="noopener noreferrer" class="apply-mobile">Apply for This WFH Role &rarr;</a>
      </div>
      <aside class="detail-sidebar">
        <div class="sidebar-card">
          <span class="sidebar-card-label">Job Details</span>
          <ul>
            <li>Type: Full-time WFH</li>
            <li>Location: Work From Home</li>
            <li>Country: ${country}</li>
            <li>Posted: ${datePosted}</li>
          </ul>
        </div>
      </aside>
    </div>
    ${randomJobs.length?`
    <div class="more-jobs">
      <div class="more-jobs-header">
        <h2>You May Also Like</h2>
        <a href="/">View all &rarr;</a>
      </div>
      <div class="jobs-grid-2col">
        ${randomJobs.map(jobTile).join('')}
      </div>
    </div>`:''}
  </div>
</main>
${footer()}
</body></html>`);
    } catch(e) { console.error(e); res.status(500).send('Server Error'); }
});

// ── START ─────────────────────────────────────────────────
async function start() {
    if (!API_URL) { console.error('[FATAL] API_URL env var is not set'); process.exit(1); }
    if (!API_KEY)  { console.error('[FATAL] API_KEY env var is not set');  process.exit(1); }

    // Pre-warm everything before accepting traffic — guarantees first request hits cache
    await Promise.all([
        loadFonts(),
        Promise.all([
            apiGetJobs({ page: 1 }),
            apiGetJobs({ page: 2 }),
            apiGetJobs({ page: 3 }),
        ]).then(() => console.log('[OK] Jobs cache pre-warmed (pages 1-3)'))
          .catch(e => console.warn('[WARN] Jobs pre-warm failed:', e.message)),
        buildSitemapCache().catch(e => console.warn('[WARN] Sitemap pre-warm failed:', e.message)),
    ]);

    await new Promise(resolve => app.listen(PORT, () => {
        console.log(`${SITE_NAME} running on :${PORT}`);
        resolve();
    }));

    fetch(`${API_URL}/health`, { headers: API_HDR })
        .then(r => r.ok
            ? console.log(`[OK] VPS API reachable → ${API_URL}`)
            : console.warn(`[WARN] VPS API health returned HTTP ${r.status}`))
        .catch(e => console.warn(`[WARN] VPS API unreachable: ${e.message}`));

    // Keep homepage cache perpetually warm — refresh every 9 min (before 10-min TTL expires)
    setInterval(() => Promise.all([
        apiGetJobs({ page: 1 }),
        apiGetJobs({ page: 2 }),
        apiGetJobs({ page: 3 }),
    ]).catch(() => {}), 9 * 60 * 1000);

    setInterval(() => buildSitemapCache().catch(e => console.warn('[WARN] Sitemap refresh failed:', e.message)), 6 * 60 * 60 * 1000);
}

start().catch(err => { console.error(err); process.exit(1); });

