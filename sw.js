// Uses the network when available so updates arrive, and the cached copy when offline.
const CACHE = "raceps-v27";
const VOICE = ["voice-on", "ready", "run-saved", "sixty", "one-hundred", "one-hundred-fifty", "two-hundred", "one-hundred-metres", "four-hundred-metres", "eight-hundred-metres", "twenty-roll", "forty-roll", "sixty-roll", "eighty-roll", "one-hundred-roll", "one-hundred-twenty-roll", "one-hundred-forty-roll", "test"];
const FILES = ["./", "index.html", "phone-core.js", "run-store.js", "remote-log.js", "manifest.json", "icon.svg", "apple-touch-icon.png", ...VOICE.map((name) => `voice/${name}.wav`)];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
