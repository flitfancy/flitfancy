import { json } from "./worker-core.js";

const WEATHER_CACHE_SECONDS = 900;
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";

export function handleFlitimeTime() {
  return json({ ok: true, epoch_ms: Date.now() }, 200, { "Cache-Control": "no-store" });
}

export async function handleFlitimeWeather(request, ctx) {
  // Existing 0.1.13 firmware displays 临港 and has no location field.
  // New firmware explicitly opts into IP-based location with ?auto=1.
  const incoming = new URL(request.url);
  const geo = incoming.searchParams.get("auto") === "1"
    ? request.cf || {}
    : { latitude: "30.90", longitude: "121.93", city: "Lingang" };
  const latitude = typeof geo.latitude === "string" && geo.latitude.trim() !== "" ? Number(geo.latitude) : geo.latitude;
  const longitude = typeof geo.longitude === "string" && geo.longitude.trim() !== "" ? Number(geo.longitude) : geo.longitude;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return json({ ok: false, error: "location unavailable" }, 503, { "Cache-Control": "no-store" });
  }
  const lat = Math.round(latitude * 100) / 100;
  const lon = Math.round(longitude * 100) / 100;
  const city = typeof geo.city === "string" && geo.city.trim() ? geo.city.trim().slice(0, 40) : "IP location";
  const cache = typeof caches === "undefined" ? null : caches.default;
  const url = new URL(request.url);
  url.pathname = "/flitime/_weather-cache";
  url.search = new URLSearchParams({ lat: String(lat), lon: String(lon) }).toString();
  const cacheKey = new Request(url.toString());
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return json({ ...(await cached.json()), city }, 200, { "Cache-Control": "no-store" });
  }

  let current, offset;
  try {
    const query = new URLSearchParams({
      latitude: String(lat), longitude: String(lon), current: "temperature_2m,weather_code",
      timezone: "auto", forecast_days: "1",
    });
    const upstream = await fetch(WEATHER_URL + "?" + query, { signal: AbortSignal.timeout(12000) });
    if (!upstream.ok) throw new Error("weather unavailable");
    const body = await upstream.json();
    current = body.current;
    offset = body.utc_offset_seconds;
  } catch {
    return json({ ok: false, error: "weather unavailable" }, 502, { "Cache-Control": "no-store" });
  }
  const temp = current?.temperature_2m;
  const code = current?.weather_code;
  if (!Number.isFinite(temp) || temp < -100 || temp > 70 ||
      !Number.isInteger(code) || code < 0 || code > 99 || !Number.isInteger(offset) ||
      offset < -43200 || offset > 50400 || offset % 60 !== 0) {
    return json({ ok: false, error: "invalid weather" }, 502, { "Cache-Control": "no-store" });
  }
  const data = {
    ok: true, temp_tenths: Math.round(temp * 10), weather_code: code,
    timezone_minutes: offset / 60, latitude: lat, longitude: lon,
    source: "Open-Meteo", source_url: "https://open-meteo.com/",
  };
  if (cache) {
    const cached = json(data, 200, { "Cache-Control": `public, max-age=${WEATHER_CACHE_SECONDS}` });
    const cacheWrite = cache.put(cacheKey, cached);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cacheWrite);
    else await cacheWrite;
  }
  return json({ ...data, city }, 200, { "Cache-Control": "no-store" });
}
