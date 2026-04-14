const http = require("http");
const https = require("https");
const url = require("url");
const zlib = require("zlib");
const OS = require("opensubtitles-api");

const PORT = process.env.PORT || 3000;

// Uses XML-RPC at api.opensubtitles.org — completely different from blocked REST endpoints
const OpenSubtitles = new OS({
  useragent: "OSTestUserAgent",
  ssl: true,
});

const MANIFEST = {
  id: "community.arabic.subtitles.v13",
  version: "13.0.0",
  name: "🇸🇦 ترجمة عربية تلقائية",
  description: "Translates subtitles to Arabic automatically",
  logo: "https://flagcdn.com/w160/sa.png",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

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

// ── Search subtitles via XML-RPC ──────────────────────────────────────────────

async function findSubtitle(imdbId, season, episode) {
  const searchParams = {
    imdbid: imdbId,         // accepts "tt1234567" or "1234567"
    sublanguageid: "all",   // get all available languages, we pick best
  };
  if (season)  searchParams.season = season;
  if (episode) searchParams.episode = episode;

  const results = await OpenSubtitles.search(searchParams);

  // results is an object keyed by 2-letter lang code: { en: {...}, fr: {...}, ... }
  if (!results || !Object.keys(results).length) return null;

  // Priority order for translation quality
  const LANG_PRIORITY = ["en","fr","it","es","pt","de","pl","ro","nl","ar"];
  for (const lang of LANG_PRIORITY) {
    if (results[lang]) return { sub: results[lang], lang };
  }

  // Fallback: take whatever language is available
  const firstLang = Object.keys(results)[0];
  return { sub: results[firstLang], lang: firstLang };
}

// ── Download subtitle ─────────────────────────────────────────────────────────

async function downloadSubtitle(subUrl) {
  const resp = await fetchUrl(subUrl, { headers: { "User-Agent": "OSTestUserAgent" } });
  if (resp.status !== 200) throw new Error(`Download failed: ${resp.status}`);

  const buf = resp.body;

  // gzip
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return new Promise((res, rej) => zlib.gunzip(buf, (e, o) => e ? rej(e) : res(o.toString("utf8"))));
  }

  // zip
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return extractFromZip(buf);
  }

  return buf.toString("utf8");
}

function extractFromZip(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf.buffer || buf);
  let offset = 0;

  while (offset < bytes.length - 30) {
    if (dv.getUint32(offset, true) !== 0x04034b50) break;
    const method = dv.getUint16(offset + 8, true);
    const compSize = dv.getUint32(offset + 18, true);
    const fnLen = dv.getUint16(offset + 26, true);
    const exLen = dv.getUint16(offset + 28, true);
    const fname = Buffer.from(bytes.slice(offset + 30, offset + 30 + fnLen)).toString();
    const dataStart = offset + 30 + fnLen + exLen;
    const data = buf.slice ? buf.slice(dataStart, dataStart + compSize) : Buffer.from(bytes.slice(dataStart, dataStart + compSize));

    if (/\.(srt|sub|txt|ass|ssa)$/i.test(fname)) {
      if (method === 0) return Buffer.from(data).toString("utf8");
      if (method === 8) return new Promise((res, rej) => zlib.inflateRaw(Buffer.from(data), (e, o) => e ? rej(e) : res(o.toString("utf8"))));
    }
    offset = dataStart + compSize;
  }
  throw new Error("No subtitle file in ZIP");
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

// ── MS Edge translation ───────────────────────────────────────────────────────

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
    const found = await findSubtitle(parts[0], parts[1], parts[2]);
    if (!found) return { subtitles: [] };

    const base = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const subUrl = found.sub.url || found.sub.utf8;
    if (!subUrl) return { subtitles: [] };

    return {
      subtitles: [{
        id: "ar_0",
        url: `${base}/translate?src=${encodeURIComponent(subUrl)}`,
        lang: "ara",
      }],
    };
  } catch (err) {
    console.error("handleSubtitles:", err.message);
    return { subtitles: [] };
  }
}

async function runDebug(type, id) {
  const log = [];
  try {
    const parts = id.split(":");
    log.push(`IMDb: ${parts[0]}, Season: ${parts[1]}, Episode: ${parts[2]}`);
    log.push(`Using: XML-RPC api.opensubtitles.org (cannot be blocked by Cloudflare)`);

    log.push(`\n=== STEP 1: Search subtitles ===`);
    const found = await findSubtitle(parts[0], parts[1], parts[2]);

    if (!found) { log.push("❌ No subtitles found in any language"); return log.join("\n"); }

    log.push(`✅ Found in language: [${found.lang}]`);
    log.push(`File: ${found.sub.filename}`);
    const subUrl = found.sub.url || found.sub.utf8;
    log.push(`URL: ${subUrl}`);

    log.push(`\n=== STEP 2: Download ===`);
    const srt = await downloadSubtitle(subUrl);
    log.push(`Length: ${srt.length}, valid: ${srt.includes("-->")}`);
    log.push(`Preview:\n${srt.slice(0, 300)}`);

    log.push(`\n=== STEP 3: Translate to Arabic ===`);
    const lines = parseSRT(srt).slice(0, 3).flatMap(c => c.lines);
    const translated = await msTranslate(lines);
    log.push(`Source: ${JSON.stringify(lines)}`);
    log.push(`Arabic: ${JSON.stringify(translated)}`);

    log.push(`\n✅ Everything works!`);
    log.push(`Install: https://stremio-arabic-subs-production-59d3.up.railway.app/manifest.json`);
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
    if (dbg) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.writeHead(200); res.end(await runDebug(dbg[1], dbg[2])); return; }

    const sub = p.match(/^\/subtitles\/(movie|series)\/(.+)\.json$/);
    if (sub) { res.setHeader("Content-Type", "application/json"); res.writeHead(200); res.end(JSON.stringify(await handleSubtitles(sub[1], sub[2], parsed))); return; }

    if (p === "/translate") {
      const src = parsed.searchParams.get("src");
      if (!src) { res.writeHead(400); res.end("Missing src"); return; }
      const srt = await downloadSubtitle(src);
      if (!srt.includes("-->")) { res.writeHead(502); res.end("Not valid SRT"); return; }
      const arabic = await translateSRT(srt);
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
