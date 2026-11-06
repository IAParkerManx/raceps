# RacePS

A phone web app for timing car performance runs, such as 0-100 km/h, rolling 60-100 and 100-200, quarter mile and 400/800 m. It installs to the home screen and works offline.

- Uses the phone's GPS and motion sensors, or a Dragy FD02 over Web Bluetooth. `dragy-core.js` decodes Dragy's NAV-PVT-like frame stream: handshake, checksum, fix quality and satellite count.
- Voice callouts for splits, run history and CSV export of raw sensor data.
- Opt-in diagnostics are sent as Netlify Forms submissions. GPS position is deliberately excluded.
- Core logic is plain JavaScript with unit tests (`*.test.js`).

Built in 2026, working with AI coding agents.
