const http = require("http");
const https = require("https");
const url = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const OPENSUBS_KEY = process.env.OPENSUBS_KEY || "";

const MANIFEST = {
  id: "community.arabic.subtitles.v10",
  version: "10.0.0",
  name: "🇸🇦 ترجمة عربية تلقائية",
  description: "Auto-translates English subtitles to Arabic",
  logo: "https://flagcdn.com/w160/sa.png",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

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

function openSubsHeaders() {
  return {
    "Api-Key": OPENSUBS_KEY,
    "Content-Type": "application/json",
    "User-Agent": "StremioArabicSubs v10.0.0",
    "Accept": "application/json",
  };
}

async function openSubsRequest(params) {
  const resp = await fetchUrl(
    `https://api.opensubtitles.com/api/v1/subtitles?${params}`,
    { headers: openSubsHeaders() }
  );
  if (resp.status !== 200) throw new Error(`OpenSubtitles ${resp.status}: ${resp.body.toString().slice(0, 300)}`);
  const data = JSON.parse(resp.body.toString());
  return data.data || [];
}

async function searchOpenSubs(imdbId, season, episode) {
  if (!OPENSUBS_KEY) throw new Error("OPENSUBS_KEY not set");

  const base = { imdb_id: imdbId.replace("tt", ""), languages: "en", order_by: "download_count" };

  // Try 1: exact season + episode
  if (season && episode) {
    const r = await openSubsRequest(new url.URLSearchParams({ ...base, season_number: season, episode_number: episode }));
    if (r.length) { console.log(`Found ${r.length} subs with season/ep filter`); return r; }
    console.log("No results with season/ep, trying without...");
  }

  // Try 2: just imdb_id (show has different numbering on OpenSubtitles)
  const r2 = await openSubsRequest(new url.URLSearchParams(base));
  console.log(`Found ${r2.length} subs without season/ep filter`);
  return r2;
}

async function getDownloadLink(fileId) {
  const resp = await fetchUrl("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: openSubsHeaders(),
    body: JSON.stringify({ file_id: fileId }),
  });
  if (resp.status !== 200) throw new Error(`Download link ${resp.status}: ${resp.body.toString().slice(0, 300)}`);
  const data = JSON.parse(resp.body.toString());
  if (!data.link) throw new Error("No download link returned");
  return data.link;
}

async function downloadAndDecode(dlUrl) {
  const resp = await fetchUrl(dlUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (resp.status !== 200) throw new Error(`Download failed: HTTP ${resp.status}`);
  const buf = resp.body;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return new Promise((resolve, reject) => zlib.gunzip(buf, (err, out) => err ? reject(err) : resolve(out.toString("utf8"))));
  }
  return buf.toString("utf8");
}

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

async function msTranslate(texts) {
  if (!texts.length) return [];
  const resp = await fetchUrl(
    "https://api-edge.cognitive.microsoft.com/translate?from=en&to=ar&api-version=3.0",
    { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify(texts.map(t => ({ Text: t }))) }
  );
  if (resp.status !== 200) throw new Error(`MS translate HTTP ${resp.status}`);
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

async function handleSubtitles(type, id, parsedUrl) {
  try {
    const parts = id.split(":");
    const results = await searchOpenSubs(parts[0], parts[1], parts[2]);
    if (!results.length) return { subtitles: [] };
    const base = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const subtitles = results.slice(0, 3).map((r, i) => {
      const fileId = r.attributes?.files?.[0]?.file_id;
      return fileId ? { id: `ar_${i}`, url: `${base}/translate?file_id=${fileId}`, lang: "ara" } : null;
    }).filter(Boolean);
    return { subtitles };
  } catch (err) {
    console.error("handleSubtitles:", err.message);
    return { subtitles: [] };
  }
}

async function runDebug(type, id) {
  const log = [];
  try {
    log.push(`OPENSUBS_KEY: ${OPENSUBS_KEY ? "YES ✅" : "NO ❌"}`);
    const parts = id.split(":");
    const imdbId = parts[0], season = parts[1], episode = parts[2];
    log.push(`IMDb: ${imdbId}, Season: ${season}, Episode: ${episode}`);

    log.push(`\n=== STEP 1: Search (with season/ep fallback) ===`);
    const results = await searchOpenSubs(imdbId, season, episode);
    log.push(`Total results: ${results.length}`);
    if (!results.length) { log.push("❌ No subs found on OpenSubtitles for this show"); return log.join("\n"); }

    const fileId = results[0].attributes?.files?.[0]?.file_id;
    log.push(`First result: "${results[0].attributes?.release}" (file_id: ${fileId})`);

    log.push(`\n=== STEP 2: Get download link ===`);
    const link = await getDownloadLink(fileId);
    log.push(`Link obtained ✅`);

    log.push(`\n=== STEP 3: Download SRT ===`);
    const srt = await downloadAndDecode(link);
    log.push(`Length: ${srt.length} chars, valid: ${srt.includes("-->")}`);
    log.push(`Preview:\n${srt.slice(0, 300)}`);

    log.push(`\n=== STEP 4: Translation test ===`);
    const lines = parseSRT(srt).slice(0, 3).flatMap(c => c.lines);
    const translated = await msTranslate(lines);
    log.push(`EN: ${JSON.stringify(lines)}`);
    log.push(`AR: ${JSON.stringify(translated)}`);

    log.push(`\n✅ Works! Install in Stremio:\nhttps://stremio-arabic-subs-production-59d3.up.railway.app/manifest.json`);
  } catch (err) {
    log.push(`\n❌ ERROR: ${err.message}`);
  }
  return log.join("\n");
}

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
    if (dbg) { const log = await runDebug(dbg[1], dbg[2]); res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.writeHead(200); res.end(log); return; }

    const sub = p.match(/^\/subtitles\/(movie|series)\/(.+)\.json$/);
    if (sub) { const r = await handleSubtitles(sub[1], sub[2], parsed); res.setHeader("Content-Type", "application/json"); res.writeHead(200); res.end(JSON.stringify(r)); return; }

    if (p === "/translate") {
      const fileId = parsed.searchParams.get("file_id");
      if (!fileId) { res.writeHead(400); res.end("Missing file_id"); return; }
      const link = await getDownloadLink(Number(fileId));
      const srt = await downloadAndDecode(link);
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
