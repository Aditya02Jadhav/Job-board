# Firstlight Platform Workflow

## End-to-end flow

```text
+-----------------------------+
| Refresh trigger             |
|                             |
| Local: server startup +     |
| daily at 04:00 local time   |
| GitHub: daily at 00:15 UTC  |
| or manual workflow dispatch |
+--------------+--------------+
               |
               v
+-----------------------------+
| Load configuration          |
| .env locally / GitHub       |
| Actions secrets and vars    |
| Select free-tier LLM        |
| Groq or Gemini              |
+--------------+--------------+
               |
               v
+-----------------------------+
| Collect public job listings|
| Jobicy API                  |
| Optional Adzuna API         |
| Greenhouse / Lever / Ashby  |
| public employer boards      |
+--------------+--------------+
               |
               v
+-----------------------------+
| Normalize and validate     |
| Required fields, URLs,      |
| dates, and source details   |
+--------------+--------------+
               |
               v
+-----------------------------+
| India relevance prefilter  |
| India/city listings and    |
| qualifying remote roles    |
+--------------+--------------+
               |
               v
+-----------------------------+
| Save pending candidates    |
| .jobboard-cache/           |
| pending-jobs.json          |
+--------------+--------------+
               |
               +----------------------------------+
               |                                  |
               v                                  v
+-----------------------------+     +-----------------------------+
| Rule-tag clear India jobs  |     | Keep current published jobs |
| as safe interim listings  |     | and merge exact matches     |
+--------------+--------------+     +--------------+--------------+
               |                                  |
               +----------------+-----------------+
                                |
                                v
                 +-----------------------------+
                 | Write interim snapshot      |
                 | public/data/jobs.json       |
                 | Existing jobs stay visible |
                 +--------------+--------------+
                                |
                                v
                 +-----------------------------+
                 | Exact deduplication         |
                 | Then LLM-assisted matching |
                 | of likely cross-source dupes|
                 +--------------+--------------+
                                |
                                v
                 +-----------------------------+
                 | LLM classification          |
                 | Role, city, location, level,|
                 | employment type, India fit  |
                 +--------------+--------------+
                                |
              +-----------------+-----------------+
              |                                   |
              v                                   v
+-----------------------------+     +-----------------------------+
| Classification succeeds    |     | AI unavailable or fails     |
| Use validated AI tags      |     | Keep clearly India-eligible |
| Reject ineligible listings |     | jobs with rule-based tags   |
+--------------+--------------+     +--------------+--------------+
              |                                   |
              +-----------------+-----------------+
                                |
                                v
                 +-----------------------------+
                 | Merge with existing jobs    |
                 | Remove exact duplicates     |
                 | Sort and calculate counts  |
                 +--------------+--------------+
                                |
                                v
                 +-----------------------------+
                 | Atomically publish final    |
                 | public/data/jobs.json       |
                 +--------------+--------------+
                                |
             +------------------+---------------------+
             |                                        |
             v                                        v
+-----------------------------+       +-----------------------------+
| Local Node server serves   |       | GitHub Actions commits and  |
| the public/ website and    |       | pushes the refreshed JSON   |
| JSON snapshot              |       | for deployment to publish   |
+--------------+--------------+       +-----------------------------+
               |
               v
+-----------------------------+
| Searchable job board       |
| Filter and browse jobs;    |
| apply via original source  |
| links and source attribution|
+-----------------------------+
```

## What happens at each stage

1. **Refresh starts.** Locally, `server.mjs` runs a refresh at startup and schedules a daily refresh for 04:00 local time while the server is running. GitHub Actions runs daily at 00:15 UTC and can also be started manually.
2. **Configuration and model selection.** Local settings are loaded from `.env`; the hosted workflow uses configured GitHub secrets and variables. The collector uses the configured free-tier Groq or Gemini model and rotates configured keys when applicable.
3. **Collection.** The pipeline reads permitted public feeds and explicitly configured employer ATS boards. It retains original application links and source attribution; unavailable optional sources can report warnings.
4. **Validation and staging.** Listings are normalized and filtered for India-relevant locations. Candidates are written to the ignored `.jobboard-cache/pending-jobs.json` before AI processing so a failed classification call does not lose the collected records.
5. **Interim publication.** Clear India-located listings can be tagged with conservative rules and merged into the existing snapshot before the LLM calls. The snapshot is written atomically, so a failed later step does not erase the existing published jobs.
6. **Deduplication and classification.** The pipeline removes exact duplicates, then uses the LLM to identify likely cross-source duplicates and classify role, city, location, experience level, employment type, and India eligibility. If AI classification fails, clearly India-eligible jobs can remain published with rule-based tags. AI-tagged or rejected results are handled according to the classification result.
7. **Final publication.** Eligible jobs are merged with existing jobs, deduplicated, sorted, and written to `public/data/jobs.json`. The report includes source counts, pipeline statistics, and actual category coverage; target counts are not fabricated.
8. **Serving and deployment.** The local Node server serves the static site and JSON file. In the GitHub workflow, the refreshed JSON is committed and pushed; the hosting platform must publish that repository update for the live site to receive it.

## Main paths

| Purpose | Path |
| --- | --- |
| Collector and LangGraph workflow | `jobboard/pipeline.py` |
| Local and hosted refresh entry point | `jobboard/__main__.py` |
| Static web server and local schedule | `server.mjs` |
| Searchable UI | `public/` |
| Published listing snapshot | `public/data/jobs.json` |
| Private pending-candidate cache | `.jobboard-cache/pending-jobs.json` |
| Hosted daily refresh | `.github/workflows/refresh-jobs.yml` |
