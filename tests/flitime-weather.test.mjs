import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const entries = new Map();
let calls = 0;

globalThis.caches = {
  default: {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, value) { entries.set(key.url, value.clone()); },
  },
};
globalThis.fetch = async (url) => {
  calls++;
  assert.equal(new URL(url).hostname, "api.open-meteo.com");
  return Response.json({ utc_offset_seconds: 28800, current: { temperature_2m: 18.8, weather_code: 3 } });
};

try {
  const path = "https://api.flitfancy.com/flitime/weather";
  const located = (url, city, latitude, longitude) => {
    const request = new Request(url);
    Object.defineProperty(request, "cf", { value: { city, latitude, longitude } });
    return request;
  };
  const first = await worker.fetch(located(path + "?auto=1&ignored=1", "Shanghai", "31.2", "121.5"), {});
  assert.equal(first.status, 200);
  const value = await first.json();
  assert.equal(value.temp_tenths, 188);
  assert.equal(value.weather_code, 3);
  assert.equal(value.source, "Open-Meteo");
  assert.equal(value.city, "Shanghai");
  assert.equal(value.timezone_minutes, 480);
  assert.match(first.headers.get("Cache-Control"), /no-store/);
  const second = await worker.fetch(located(path + "?auto=1&ignored=2", "Shanghai", "31.2", "121.5"), {});
  assert.equal(second.status, 200);
  assert.equal(calls, 1, "query strings must not bypass the shared weather cache");
  const nearby = await worker.fetch(located(path + "?auto=1", "Nearby", "31.201", "121.501"), {});
  assert.equal((await nearby.json()).city, "Nearby", "cached weather must not leak a previous city label");
  assert.equal(calls, 1);
  const another = await worker.fetch(located(path + "?auto=1", "Wuhan", "30.6", "114.3"), {});
  assert.equal((await another.json()).city, "Wuhan");
  assert.equal(calls, 2, "different locations must not share weather cache entries");
  const noLocation = await worker.fetch(new Request(path + "?auto=1"), {});
  assert.equal(noLocation.status, 503);
  assert.equal(calls, 2, "missing client location must not silently use a fixed city");

  const legacy = await worker.fetch(new Request(path), {});
  assert.equal((await legacy.json()).city, "Lingang", "deployed firmware keeps its fixed city until upgraded");
  assert.equal(calls, 3);
  entries.clear();
  globalThis.fetch = async () => Response.json({ current: { temperature_2m: 500, weather_code: -1 } });
  const bad = await worker.fetch(located(path + "?auto=1", "Shanghai", "31.2", "121.5"), {});
  assert.equal(bad.status, 502);
  assert.equal(entries.size, 0, "invalid upstream data must not be cached");

  globalThis.fetch = async () => { throw new Error("unavailable"); };
  const unavailable = await worker.fetch(located(path + "?auto=1", "Shanghai", "31.2", "121.5"), {});
  assert.equal(unavailable.status, 502);
  assert.equal(entries.size, 0);

  const before = Date.now();
  const clockResponse = await worker.fetch(new Request("https://api.flitfancy.com/flitime/time"), {});
  const clock = await clockResponse.json();
  assert.equal(clockResponse.status, 200);
  assert.ok(clock.epoch_ms >= before && clock.epoch_ms <= Date.now());
  assert.match(clockResponse.headers.get("Cache-Control"), /no-store/);
  console.log("Flitime weather and time checks passed");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
}
