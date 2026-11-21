import asyncio
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

from .pipeline import build_graph, select_llm_provider

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "public" / "data" / "jobs.json"


async def main() -> None:
    load_dotenv(ROOT / ".env")
    provider, model, _ = select_llm_provider(
        os.getenv("LLM_PROVIDER"),
        os.getenv("GROQ_API_KEY"),
        os.getenv("GEMINI_API_KEY"),
    )

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.info("Using %s free-tier model %s.", provider, model)
    result = await build_graph().ainvoke({"output_path": str(OUTPUT_PATH)})
    for warning in result.get("warnings", []):
        logging.warning("%s", warning)
    report = result["report"]
    stats = report["pipelineStats"]
    source_inventory = ", ".join(
        f"{name}: {count}" for name, count in report["sourceCounts"].items()
    )
    logging.info("Source records fetched: %s (%s).", stats["fetched"], source_inventory)
    logging.info(
        "India/remote candidates: %s; after deduplication: %s; confirmed India-eligible: %s; "
        "rejected as not India-eligible: %s.",
        stats["indiaCandidates"],
        stats["afterDeduplication"],
        stats["indiaEligible"],
        stats["rejectedAsNotIndiaEligible"],
    )
    logging.info(
        "Published %s jobs from %s sources. Targets met: freshers %s/100, "
        "full-time %s/100, internships %s/100.",
        report["jobCount"],
        report["sourceCount"],
        report["coverage"]["freshers"]["count"],
        report["coverage"]["fullTime"]["count"],
        report["coverage"]["internships"]["count"],
    )
    if report["jobCount"] < 300 or not all(item["met"] for item in report["coverage"].values()):
        logging.warning(
            "The 300-job / 100-per-category goal was not met. Counts reflect verified, "
            "eligible listings only; configure more permitted feeds or employer boards."
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        logging.error("Daily refresh failed: %s", error)
        raise SystemExit(1) from error
