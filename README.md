# Firstlight

Firstlight is a searchable job board for India-focused full-time opportunities, internships, and early-career roles. Its daily collector uses permitted public job APIs and explicitly configured employer ATS boards; a LangGraph agent removes duplicate openings, tags location/city and job type, and publishes the JSON data used by the existing web UI.

The goal is **100 freshers/entry-level, 100 full-time, and 100 internship listings**. These are targets, not guaranteed feed inventory. Categories can overlap (a fresher role can also be full-time). The site reports the actual count in each category and never creates fake listings or counts ineligible jobs toward a target.

## Local setup

Requires Node.js 20+ and the project-local `.venv`. Python and packages are kept in the project environment, not installed globally.

```powershell
# If needed, create the project virtual environment with uv and an available Python:
uv python install 3.12
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
Copy-Item .env.example .env
```

Set `GROQ_API_KEY` or `GEMINI_API_KEY` in `.env`, then start the website with `start.bat` or `npm start`. Open `http://localhost:4173`. While the local server is running, it starts a refresh on launch and schedules another for 04:00 local time each day. Set `AUTO_REFRESH=false` to disable the local scheduler. A running server is required for local scheduled refreshes.

Run the collector and LangGraph agent locally with `npm run refresh`. It reads source and LLM settings from `.env` and writes the job snapshot to `public/data/jobs.json`. New candidates are staged in the private, ignored `.jobboard-cache/pending-jobs.json` and clearly India-eligible candidates are merged into the snapshot before AI tagging; if tagging fails, those listings remain available with visibly marked rule-based tags. Existing jobs are retained and exact duplicates are removed when the final snapshot is published. Unit tests run with `npm test`.

## Deploy to Vercel

The website is a static frontend. `vercel.json` sets the Framework Preset to **Other** and serves `public/` as the output directory, so Vercel does not try to run the Python job collector or `server.mjs`. The published `public/data/jobs.json` is served with the site.

To deploy:

1. Import this GitHub repository into Vercel and set the Root Directory to the repository root.
2. Leave the Build Command and Install Command empty (the committed `vercel.json` also overrides them) and deploy.
3. Add the LLM and optional Adzuna credentials as **GitHub Actions secrets**, not Vercel environment variables. The scheduled `Refresh job board` workflow runs the collector and pushes updated `public/data/jobs.json`; Vercel then redeploys the new snapshot from that commit.

The Node server and its in-process daily timer are for local use only. Vercel static deployments do not run that server or the Python collector. If the Vercel build still reports `PYTHON_ENTRYPOINT_NOT_FOUND`, confirm the deployed commit contains `vercel.json`, the Root Directory is correct, and the project's Framework Preset is **Other**.

## Sources and configuration

- **Jobicy public Jobs API** is queried for APAC and Anywhere with cursor pagination, at least one second between requests, and up to 100 jobs per page. Its public feed covers a rolling seven-day window. Listings retain their Jobicy URL and attribution. An APAC label by itself is not treated as proof a role is open to India.
- **Adzuna India Jobs API** can broaden the India-specific inventory. Register for credentials, set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` in `.env` or as GitHub Actions secrets, and review Adzuna's current API terms and attribution requirements before use. Application links use the API's `redirect_url`.
- **Greenhouse, Lever, and Ashby** public job-board APIs are enabled by default for 12 boards with active listings relevant to India: Groww, Stripe, GitLab, Coinbase, Datadog, Meesho, CRED, Zeta, Sarvam, Ema, Plane, and AiPrise. Each listing keeps its application URL and includes a link to the employer's board for attribution. The collector uses public [Greenhouse Job Board](https://developers.greenhouse.io/job-board.html), [Lever postings](https://github.com/lever/postings-api), and [Ashby posting](https://developers.ashbyhq.com/docs/public-job-posting-api) APIs, not search-page scraping. Ashby's API accepts both current `jobs` and legacy `jobPostings` response shapes.
- You can override the default company list in `.env` or the GitHub Actions `COMPANY_BOARDS` variable. Only add board IDs whose public listings you are permitted to display. Example:

```json
[
  { "provider": "greenhouse", "board": "example", "company": "Example Co" },
  { "provider": "lever", "board": "example", "company": "Example Co" },
  { "provider": "ashby", "board": "example", "company": "Example Co" }
]
```

`JOBICY_MAX_PAGES_PER_GEO` controls the Jobicy page cap (1–10, default 5). Set `COMPANY_BOARDS=[]` to disable the default ATS boards. More pages and configured public ATS boards may increase inventory; they cannot guarantee the target. Sources that fail are listed as warnings; the Jobicy feed is required and a failed refresh does not overwrite the previous snapshot.

If `COMPANY_BOARDS` is unset or blank, the 12 default ATS boards are used; an explicit empty JSON array disables them. The refresh report includes a collection funnel (`pipelineStats`) and per-source fetched counts, so it is possible to distinguish feed inventory from India-eligibility filtering or duplicate removal. Adzuna is an advertising/jobs API, not an API for posting ads; it can provide job ads for display, but registration, approval, quotas, and attribution are controlled by Adzuna. The collector treats it as an optional source and does not depend on access being granted.

Remotive's published RSS terms permit displaying its listings on your own app or website when Remotive is named and each listing links back to Remotive. They prohibit submitting those listings to other job aggregators. Firstlight does not currently collect the Remotive feed; any integration must retain the required attribution and original links.

### Can job websites be scraped?

Technically, many public career pages can be fetched and parsed. Publicly viewable does **not** automatically mean a site permits automated collection or republication. We should only add a site-specific collector after checking that site's current terms, robots guidance, and any feed/API rules. For permitted sources, use a small allowlist of employer career pages, low request rates, caching/conditional requests, source attribution and original application links. Do not log in, bypass a paywall/CAPTCHA/anti-bot control, evade rate limits, or scrape a site whose rules prohibit it. Robots.txt is useful crawler guidance, not a license to republish.

So, yes: public employer pages can expand the board where their terms permit it. The current collector deliberately uses documented Jobicy/Adzuna feeds and public Greenhouse/Lever/Ashby job-board APIs rather than indiscriminately crawling job aggregators.

## LangGraph processing

The `jobboard` graph runs four steps:

1. **Collect** public API / configured ATS listings and keep source links.
2. **Deduplicate** exact matches locally, then ask the LLM to identify definite cross-feed duplicates; conservative company/title/location checks prevent unrelated roles from being merged.
3. **Classify** role family, city, location, experience level, employment type, and India eligibility using structured output. City aliases are canonicalized, and explicit source employment types take precedence over model guesses; clear internship titles are used when source type is unavailable. Only explicitly India-eligible listings are published.
4. **Publish** a sorted JSON snapshot and real per-category coverage counts.

## Free-tier AI providers

The LangGraph agent uses whichever provider key is available. `LLM_PROVIDER=auto` (the default) selects Groq if `GROQ_API_KEY` is set; otherwise it selects Gemini if `GEMINI_API_KEY` is set. Use `LLM_PROVIDER=groq` or `LLM_PROVIDER=gemini` to explicitly choose one. No OpenAI key or paid-provider fallback is configured.

The agent pins the models to IDs currently documented in each provider's free tier:

- **Groq:** `openai/gpt-oss-20b` ([model catalog](https://console.groq.com/docs/models), [free-plan limits](https://console.groq.com/docs/rate-limits)). Groq uses native strict JSON Schema output for the nested job batches, so responses are constrained to the requested schema.
- **Gemini:** `gemini-3.5-flash-lite` ([model catalog](https://ai.google.dev/gemini-api/docs/models), [pricing](https://ai.google.dev/gemini-api/docs/pricing)). Google's current pricing page lists free input/output tokens for this model.

Free usage has provider-set rate limits and availability can change; free does not mean unlimited or guaranteed daily capacity. The workflow never switches to a paid model automatically. The provider account/project still controls whether requests are billed: keep the account on the free tier, avoid enabling paid billing, and set provider-side spending/usage controls where offered. This app cannot override account billing settings or guarantee a provider won't change its free-tier terms. Gemini's free-tier terms state submitted data may be used to improve Google's products; review current provider terms before sending job descriptions. Change the pinned IDs in `jobboard/pipeline.py` only after confirming the replacement remains available on the free tier and supports structured output.

Groq requests are paced at 15 seconds by default to stay below free-plan token limits; tagging batches contain at most five posts and send only a short description excerpt. Change `LLM_REQUEST_INTERVAL_SECONDS` in `.env` to match the quotas shown for your account. In `LLM_PROVIDER=auto` mode, if a Groq request hits a daily token (TPD) limit, the agent retries using `GROQ_API_KEY_2`, then any additional numbered keys (`GROQ_API_KEY_3`, etc.); when all configured Groq keys are exhausted, it switches to `GEMINI_API_KEY`. Gemini quota errors similarly rotate through `GEMINI_API_KEY_2` and any additional numbered keys. Add keys locally in `.env`; for GitHub Actions, configure the corresponding repository secrets. Keys are never logged. Explicitly setting `LLM_PROVIDER=groq` disables Gemini; setting `LLM_PROVIDER=gemini` starts with Gemini and rotates Gemini keys.

Important: Groq limits are organization-scoped, and Gemini API limits are project-scoped ([Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)). Two keys from the same organization/project share quota, so rotation helps only when the backup key has separate available quota. Minute-level limits are not automatically rotated for Groq.

## Automatic daily refresh

`.github/workflows/refresh-jobs.yml` runs daily at 00:15 UTC and can also be manually dispatched after the project is hosted in a GitHub repository. Configure `GROQ_API_KEY` and optionally `GROQ_API_KEY_2` and/or `GEMINI_API_KEY` as repository secrets, and optionally `LLM_PROVIDER` as a repository variable. Also configure optional `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` secrets and `COMPANY_BOARDS` variable when you are authorized to use them. The workflow creates an isolated Python environment on its runner, refreshes the snapshot, and commits it to the repository. The website checks for updated data hourly while open.

The existing static Node server serves the current snapshot; deploy the repository to a host that publishes commits for the daily update to become public.
