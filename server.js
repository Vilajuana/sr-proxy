import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

const {
  SR_API_KEY,
  PROXY_API_KEY,
  SR_SOCCER_BASE = "/soccer/trial/v4/es"
} = process.env;

if (!SR_API_KEY || !PROXY_API_KEY) {
  console.error("Faltan SR_API_KEY o PROXY_API_KEY en variables de entorno.");
  process.exit(1);
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan("tiny"));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// --- utilidades ---
const CACHE = new Map();
const CACHE_TTL_MS = 30_000;
const SR_BASE = "https://api.sportradar.com";

async function getJsonWithCache(url) {
  const hit = CACHE.get(url), now = Date.now();
  if (hit && now - hit.t < CACHE_TTL_MS) return hit.d;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  const data = await r.json();
  CACHE.set(url, { t: now, d: data });
  return data;
}

function baseUrlFrom(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}`;
}

// --- seguridad: /healthz y /openapi.yaml sin auth para probar rápido ---
app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path === "/openapi.yaml") return next();
  const key = req.header("X-API-Key");
  if (key !== PROXY_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ================== ENDPOINTS ==================

// Buscar partidos por fecha y (opcional) equipos
app.get("/search/matches", async (req, res) => {
  try {
    const { date, home, away } = req.query;
    if (!date) return res.status(400).json({ error: "Falta ?date=YYYY-MM-DD" });
    const url = `${SR_BASE}${SR_SOCCER_BASE}/schedules/${encodeURIComponent(date)}/schedules.json?api_key=${SR_API_KEY}`;
    const data = await getJsonWithCache(url);
    let matches = (data?.sport_events || []).map(ev => {
      const h = ev?.competitors?.find(c => c.qualifier === "home")?.name ?? "";
      const a = ev?.competitors?.find(c => c.qualifier === "away")?.name ?? "";
      return { match_id: ev?.id, scheduled: ev?.start_time, league: ev?.tournament?.name, home: h, away: a };
    });
    if (home) matches = matches.filter(m => m.home?.toLowerCase().includes(String(home).toLowerCase()));
    if (away) matches = matches.filter(m => m.away?.toLowerCase().includes(String(away).toLowerCase()));
    res.json({ date, count: matches.length, matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cuotas y probabilidades de un partido
app.get("/odds/match/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const probUrl = `${SR_BASE}${SR_SOCCER_BASE}/matches/${encodeURIComponent(id)}/probabilities.json?api_key=${SR_API_KEY}`;
    const sumUrl  = `${SR_BASE}${SR_SOCCER_BASE}/matches/${encodeURIComponent(id)}/summary.json?api_key=${SR_API_KEY}`;
    const [prob, sum] = await Promise.all([getJsonWithCache(probUrl), getJsonWithCache(sumUrl)]);

    const home = sum?.sport_event?.competitors?.find(c => c.qualifier === "home")?.name;
    const away = sum?.sport_event?.competitors?.find(c => c.qualifier === "away")?.name;
    const scheduled = sum?.sport_event?.start_time;

    const markets = (prob?.probabilities?.markets || []).map(m => ({
      key: m.name,
      outcomes: (m.outcomes || []).map(o => ({
        label: o.name,
        probability: o.probability,
      }))
    }));

    res.json({ match_id: id, scheduled, home, away, markets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verifica si el servidor está vivo
app.get("/healthz", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ SR Proxy activo en puerto", PORT));
