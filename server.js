const http = require("http");
const https = require("https");
const url = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;

const MANIFEST = {
  id: "community.arabic.subtitles.v12",
  version: "12.0.0",
  name: "🇸🇦 ترجمة عربية تلقائية",
  description: "Translates subtitles from ANY language to Arabic — no API key needed",
  logo: "https://flagcdn.com/w160/sa.png",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

// Language priority — best for MS Edge translation quality
const SEARCH_LANGS = ["eng", "fre", "ita", "spa", "por", "ger", "pol", "rum", "dut", "all"];

// ── HTTP helper (follows redirects) ──────────────────────────────────────────

function fetchUrl(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const parsed = new url.URL(urlStr);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: options.method || "GET", headers: options.headers || {} },
      (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith("http") ? res.headers.location : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
          return fetchUrl(loc, { headers: options.headers }, redirectCount + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── OpenSubtitles.ORG REST API (no key needed) ───────────────────────────────
// Docs: https://trac.opensubtitles.org/projects/opensubtitles/wiki/DevReadFirst

async function searchSubtitlesOrg(imdbId, season, episode, lang) {
  const cleanId = imdbId.replace("tt", "").replace(/^0+/, ""); // strip leading zeros

  let path = `/search/imdbid-${cleanId}`;
  if (season)  path += `/season-${season}`;
  if (episode) path += `/episode-${episode}`;
  path += `/sublanguageid-${lang}`;

  const resp = await fetchUrl(`https://rest.opensubtitles.org${path}`, {
    headers: {
      "User-Agent": "TemporaryUserAgent",
      "X-User-Agent": "TemporaryUserAgent",
      "Accept": "application/json",
    },
  });

  if (resp.status !== 200) throw new Error(`OpenSubtitles.org ${resp.status}: ${resp.body.toString().slice(0, 200)}`);

  const body = resp.body.toString();
  if (!body || body === "null" || body === "[]") return [];

  try {
    const data = JSON.parse(body);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Try all languages in priority order, return first match
async function findSubtitle(imdbId, season, episode) {
  for (const lang of SEARCH_LANGS) {
    // Try with season+episode first
    if (season && episode) {
      const r = await searchSubtitlesOrg(imdbId, season, episode, lang);
      if (r.length) { console.log(`Found ${r.length} subs [${lang}] with season/ep`); return { results: r, lang }; }
    }
    // Fallback: no season/episode filter
    const r2 = await searchSubtitlesOrg(imdbId, null, null, lang);
    if (r2.length) { console.log(`Found ${r2.length} subs [${lang}] without season/ep`); return { results: r2, lang }; }
  }
  return { results: [], lang: null };
}

// ── Download subtitle (handles .gz and plain) ────────────────────────────────

async function downloadSubtitle(subDownloadLink) {
  // OpenSubtitles.org returns a ZipDownloadLink — fetch it
  const resp = await fetchUrl(subDownloadLink, {
    headers: { "User-Agent": "TemporaryUserAgent" },
  });
  if (resp.status !== 200) throw new Error(`Subtitle download failed: ${resp.status}`);

  const buf = resp.body;

  // Gzip?
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return new Promise((res, rej) => zlib.gunzip(buf, (e, o) => e ? rej(e) : res(o.toString("utf8"))));
  }

  // ZIP? (opensubtitles.org wraps in zip)
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return extractSRTFromZip(buf);
  }

  return buf.toString("utf8");
}

function extractSRTFromZip(zipBuf) {
  const bytes = new Uint8Array(zipBuf);
  const view = new DataView(zipBuf.buffer || zipBuf);
  let offset = 0;

  while (offset < bytes.length - 30) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const fileName = Buffer.from(bytes.slice(offset + 30, offset + 30 + fileNameLen)).toString();
    const dataStart = offset + 30 + fileNameLen + extraLen;
    const compressedData = zipBuf.slice ? zipBuf.slice(dataStart, dataStart + compressedSize) : Buffer.from(bytes.slice(dataStart, dataStart + compressedSize));

    if (fileName.toLowerCase().match(/\.(srt|sub|txt|ass|ssa)$/)) {
      if (method === 0) return Buffer.from(compressedData).toString("utf8");
      if (method === 8) {
        return new Promise((res, rej) => zlib.inflateRaw(Buffer.from(compressedData), (e, o) => e ? rej(e) : res(o.toString("utf8"))));
      }
    }
    offset = dataStart + compressedSize;
  }
  throw new Error("No subtitle file found in ZIP");
}

// ── SRT parse / build ────────────────────────────────────────────────────────

function parseSRT(content) {
  const cues = [];
  const blocks = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.trim().split("\n");
    if (rows.length < 2) continue;
    if (!/^\d+$/.test(rows[0].trim())) continue;
    if (!rows[1].includes("-->")) continue;
    const lines = rows.slice(2).map(l => l.trim().replace(/<[^>]+>/g, "")).filter(Boolean);
    if (lines.length) cues.push({ id: rows[0].trim(), time: rows[1].trim(), lines });
  }
  return cues;
}

function buildSRT(cues) {
  return cues.map(c => `${c.id}\n${c.time}\n${c.lines.join("\n")}`).join("\n\n") + "\n";
}

// ── MS Edge translation (auto-detects source language) ───────────────────────

async function msTranslate(texts) {
  if (!texts.length) return [];
  const resp = await fetchUrl(
    "https://api-edge.cognitive.microsoft.com/translate?to=ar&api-version=3.0",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(texts.map(t => ({ Text: t }))),
    }
  );
  if (resp.status !== 200) throw new Error(`MS translate ${resp.status}: ${resp.body.toString().slice(0,200)}`);
  return JSON.parse(resp.body.toString()).map(d => d.translations?.[0]?.text ?? "");
}

async function translateSRT(srt) {
  const cues = parseSRT(srt);
  if (!cues.length) return srt;
  const flat = [], pos = [];
  for (let ci = 0; ci < cues.length; ci++)
    for (let li = 0; li < cues[ci].lines.length; li++) { flat.push(cues[ci].lines[li]); pos.push([ci, li]); }
  const CHUNK = 100;
  const chunks = [];
  for (let i = 0; i < flat.length; i += CHUNK) chunks.push(flat.slice(i, i + CHUNK));
  const results = (await Promise.all(chunks.map(msTranslate))).flat();
  const out = cues.map(c => ({ ...c, lines: [...c.lines] }));
  for (let i = 0; i < pos.length; i++) { const [ci, li] = pos[i]; out[ci].lines[li] = results[i] || cues[ci].lines[li]; }
  return buildSRT(out);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleSubtitles(type, id, parsedUrl) {
  try {
    const parts = id.split(":");
    const { results } = await findSubtitle(parts[0], parts[1], parts[2]);
    if (!results.length) return { subtitles: [] };
    const base = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const subtitles = results.slice(0, 3).map((r, i) => {
      const dlLink = r.SubDownloadLink || r.ZipDownloadLink;
      return dlLink ? { id: `ar_${i}`, url: `${base}/translate?src=${encodeURIComponent(dlLink)}`, lang: "ara" } : null;
    }).filter(Boolean);
    return { subtitles };
  } catch (err) {
    console.error("handleSubtitles:", err.message);
    return { subtitles: [] };
  }
}

async function handleTranslate(parsedUrl) {
  const src = parsedUrl.searchParams.get("src");
  if (!src) throw new Error("Missing ?src=");
  const srt = await downloadSubtitle(src);
  if (!srt.includes("-->")) throw new Error(`Not valid SRT: ${srt.slice(0,200)}`);
  return translateSRT(srt);
}

async function runDebug(type, id) {
  const log = [];
  try {
    const parts = id.split(":");
    const imdbId = parts[0], season = parts[1], episode = parts[2];
    log.push(`IMDb: ${imdbId}, Season: ${season}, Episode: ${episode}`);
    log.push(`Using: opensubtitles.ORG (no key needed)`);

    log.push(`\n=== STEP 1: Search subtitles ===`);
    const { results, lang } = await findSubtitle(imdbId, season, episode);
    log.push(`Found: ${results.length} in language [${lang || "none"}]`);
    if (!results.length) { log.push("❌ No subtitles found"); return log.join("\n"); }

    const first = results[0];
    log.push(`First: "${first.MovieReleaseName || first.SubFileName}"`);
    const dlLink = first.SubDownloadLink || first.ZipDownloadLink;
    log.push(`Download URL: ${dlLink}`);

    log.push(`\n=== STEP 2: Download subtitle ===`);
    const srt = await downloadSubtitle(dlLink);
    log.push(`Length: ${srt.length}, valid: ${srt.includes("-->")}`);
    log.push(`Preview:\n${srt.slice(0, 300)}`);

    log.push(`\n=== STEP 3: Translate to Arabic ===`);
    const lines = parseSRT(srt).slice(0, 3).flatMap(c => c.lines);
    const translated = await msTranslate(lines);
    log.push(`Source: ${JSON.stringify(lines)}`);
    log.push(`Arabic: ${JSON.stringify(translated)}`);

    log.push(`\n✅ Works! Install in Stremio:\nhttps://stremio-arabic-subs-production-59d3.up.railway.app/manifest.json`);
  } catch (err) {
    log.push(`\n❌ ERROR: ${err.message}`);
  }
  return log.join("\n");
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = new url.URL(req.url, `http://localhost:${PORT}`);
  const p = parsed.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  try {
    if (p === "/" || p === "/manifest.json") {
      res.setHeader("Content-Type", "application/json"); res.writeHead(200); res.end(JSON.stringify(MANIFEST)); return;
    }
    const dbg = p.match(/^\/debug\/(movie|series)\/(.+)$/);
    if (dbg) {
      const log = await runDebug(dbg[1], dbg[2]);
      res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.writeHead(200); res.end(log); return;
    }
    const sub = p.match(/^\/subtitles\/(movie|series)\/(.+)\.json$/);
    if (sub) {
      const r = await handleSubtitles(sub[1], sub[2], parsed);
      res.setHeader("Content-Type", "application/json"); res.writeHead(200); res.end(JSON.stringify(r)); return;
    }
    if (p === "/translate") {
      const arabic = await handleTranslate(parsed);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.writeHead(200); res.end(arabic); return;
    }
    res.writeHead(404); res.end("Not found");
  } catch (err) {
    console.error(err.message);
    res.writeHead(500); res.end(`Error: ${err.message}`);
  }
});

server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
