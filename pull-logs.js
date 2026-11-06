// Downloads shared diagnostics from Netlify into ./logs. Not part of the deployed site.
// Usage: NETLIFY_TOKEN=... NETLIFY_SITE_ID=... node pull-logs.js
const fs = require("fs");
const path = require("path");

const API = "https://api.netlify.com/api/v1";
const FORM_NAME = "raceps-logs";
const PAGE_SIZE = 100;
const { NETLIFY_TOKEN: token, NETLIFY_SITE_ID: siteId } = process.env;

async function get(url) {
  const response = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function main() {
  if (!token || !siteId) throw new Error("Set NETLIFY_TOKEN and NETLIFY_SITE_ID");
  const forms = await get(`/sites/${siteId}/forms`);
  const form = forms.find((f) => f.name === FORM_NAME);
  if (!form) throw new Error(`Form "${FORM_NAME}" not found. Is form detection enabled?`);

  fs.mkdirSync("logs", { recursive: true });
  let saved = 0;
  for (let page = 1; ; page++) {
    const submissions = await get(`/forms/${form.id}/submissions?per_page=${PAGE_SIZE}&page=${page}`);
    for (const submission of submissions) {
      const { session, version, device, payload } = submission.data;
      const record = { received: submission.created_at, session, version, device, entries: JSON.parse(payload) };
      fs.writeFileSync(path.join("logs", `${submission.id}.json`), JSON.stringify(record, null, 2));
      saved++;
    }
    if (submissions.length < PAGE_SIZE) break;
  }
  console.log(`Saved ${saved} submissions to ./logs`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
