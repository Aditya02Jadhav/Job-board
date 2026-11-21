import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from langchain_core.messages import HumanMessage

from jobboard.pipeline import (
    DuplicateGroups,
    Job,
    LLMRequestPacer,
    TagBatch,
    TaggedJob,
    build_graph,
    clean_text,
    collect_ats_board,
    classify_jobs,
    exact_deduplicate,
    configured_groq_api_keys,
    configured_gemini_api_keys,
    fallback_tags,
    LLMKeyPool,
    invoke_structured,
    is_gemini_quota_error,
    is_groq_daily_token_limit,
    llm_deduplicate,
    merge_ai_duplicate_groups,
    normalize_date,
    normalize_city,
    normalize_employment_type,
    normalize_level,
    normalize_role,
    normalize_job,
    parse_company_boards,
    may_be_india_eligible,
    quota_coverage,
    select_llm_provider,
    structured_output,
)


SOURCE = {"name": "Example", "url": "https://example.com/jobs"}


def make_job(
    title: str = "Graduate Software Engineer",
    company: str = "Example Labs",
    location: str = "Bengaluru, India",
    url: str = "https://example.com/jobs/1",
) -> Job:
    job = normalize_job(
        {
            "title": title,
            "company": company,
            "location": location,
            "description": "<p>Build software.</p>",
            "url": url,
            "posted_at": "2026-11-20T08:30:00+05:30",
        },
        SOURCE,
    )
    assert job is not None
    return job


class FakeStructuredModel:
    def __init__(self, schema: type) -> None:
        self.schema = schema
        self.messages: list = []

    async def ainvoke(self, messages: list) -> TagBatch | DuplicateGroups:
        self.messages = messages
        payload = json.loads(next(item.content for item in messages if isinstance(item, HumanMessage)))
        if self.schema is DuplicateGroups:
            return DuplicateGroups(groups=[])
        return TagBatch(
            jobs=[
                TaggedJob(
                    id=item["id"],
                    role="Engineering",
                    city="Bengaluru",
                    location="Bengaluru, India",
                    level="Fresher",
                    employment_type="Full-time",
                    india_eligible=True,
                )
                for item in payload
            ]
        )


class FakeLLM:
    def __init__(self) -> None:
        self.structured_models: list[FakeStructuredModel] = []

    def with_structured_output(self, schema: type) -> FakeStructuredModel:
        model = FakeStructuredModel(schema)
        self.structured_models.append(model)
        return model


class FakeGroq:
    def __init__(self) -> None:
        self.options: dict = {}

    def with_structured_output(self, schema: type, **kwargs):
        self.options = kwargs
        return FakeStructuredModel(schema)


class IncompleteOnceModel:
    def __init__(self) -> None:
        self.calls = 0

    async def ainvoke(self, messages: list) -> TagBatch | DuplicateGroups:
        result = await FakeStructuredModel(TagBatch).ainvoke(messages)
        self.calls += 1
        if self.calls == 1 and len(result.jobs) > 1:
            return TagBatch(jobs=result.jobs[:-1])
        return result


class MisclassifyingTagModel:
    async def ainvoke(self, messages: list) -> TagBatch:
        payload = json.loads(next(item.content for item in messages if isinstance(item, HumanMessage)))
        return TagBatch(
            jobs=[
                TaggedJob(
                    id=item["id"],
                    role="Engineering",
                    city="Banglore",
                    location="Banglore, India",
                    level="Internship",
                    employment_type="Internship",
                    india_eligible=True,
                )
                for item in payload
            ]
        )


class MisclassifyingTagLLM:
    def with_structured_output(self, schema: type) -> MisclassifyingTagModel:
        return MisclassifyingTagModel()


class DailyLimitError(Exception):
    status_code = 429
    body = {
        "error": {
            "message": "Token limit reached for tokens per day (TPD).",
            "code": "rate_limit_exceeded",
        }
    }


class MinuteLimitError(Exception):
    status_code = 429
    body = {
        "error": {
            "message": "Rate limit reached for tokens per minute (TPM).",
            "code": "rate_limit_exceeded",
        }
    }


class GeminiQuotaError(Exception):
    code = 429
    status = "RESOURCE_EXHAUSTED"
    message = "Quota exceeded for requests per minute."


class DailyLimitStructuredModel:
    async def ainvoke(self, messages: list):
        raise DailyLimitError()


class GeminiQuotaStructuredModel:
    async def ainvoke(self, messages: list):
        raise GeminiQuotaError()


class FailingTagLLM:
    def with_structured_output(self, schema: type):
        if schema is DuplicateGroups:
            return FakeStructuredModel(schema)
        return DailyLimitStructuredModel()


class PipelineTests(unittest.TestCase):
    def test_strips_markup_and_normalizes_published_date(self) -> None:
        self.assertEqual(clean_text("<p>Hello&nbsp;world</p><script>hidden()</script>"), "Hello world")
        self.assertEqual(
            normalize_date("2026-11-20T08:30:00+05:30"),
            "2026-11-20T03:00:00Z",
        )

    def test_normalizes_model_category_variants_to_published_values(self) -> None:
        self.assertEqual(normalize_employment_type("Full-Time"), "Full-time")
        self.assertEqual(normalize_employment_type("Full time"), "Full-time")
        self.assertEqual(normalize_level("New Graduate"), "Entry-level")
        with self.assertRaisesRegex(ValueError, "unsupported employment type"):
            normalize_employment_type("Seasonal")

    def test_normalizes_city_aliases_and_case(self) -> None:
        self.assertEqual(normalize_city("Bangalore, India", "Bangalore, India"), "Bengaluru")
        self.assertEqual(normalize_city("Banglore India", "Banglore India"), "Bengaluru")
        self.assertEqual(normalize_city("hyderabad", "Hyderabad, Telangana"), "Hyderabad")
        self.assertEqual(normalize_city("Not specified", "Remote · India"), "Remote")
        self.assertTrue(may_be_india_eligible(make_job(location="Banglore India")))

    def test_uses_clear_title_evidence_for_job_role(self) -> None:
        self.assertEqual(normalize_role("Engineering", "Senior Copywriter"), "Content & Copywriting")
        self.assertEqual(normalize_role("HR", "People Partner"), "Human Resources")

    def test_fallback_does_not_infer_internship_from_description(self) -> None:
        job = make_job(
            title="Senior Copywriter",
            location="Bangalore, India",
        )
        job["description"] = "Join our internationally distributed team."
        job["employmentType"] = ""
        job["sourceEmploymentType"] = ""

        tagged = fallback_tags(job)

        self.assertIsNotNone(tagged)
        assert tagged is not None
        self.assertEqual(tagged["role"], "Content & Copywriting")
        self.assertEqual(tagged["city"], "Bengaluru")
        self.assertEqual(tagged["employmentType"], "Other")
        self.assertNotEqual(tagged["employmentType"], "Internship")

    def test_classification_prioritizes_source_and_title_evidence(self) -> None:
        async def verify() -> None:
            internship = make_job(
                title="Marketing internship (brand & communication)",
                url="https://example.com/jobs/internship",
            )
            internship["sourceEmploymentType"] = "FullTime"
            title_internship = make_job(
                title="Product User Research, Intern",
                url="https://example.com/jobs/title-internship",
            )
            copywriter = make_job(
                title="Senior Copywriter",
                url="https://example.com/jobs/copywriter",
            )
            jobs = await classify_jobs(
                [internship, title_internship, copywriter],
                MisclassifyingTagLLM(),
                LLMRequestPacer(0),
            )
            by_title = {job["title"]: job for job in jobs}

            self.assertEqual(by_title[internship["title"]]["employmentType"], "Full-time")
            self.assertEqual(by_title[internship["title"]]["level"], "Unspecified")
            self.assertEqual(by_title[internship["title"]]["role"], "Marketing")
            self.assertEqual(by_title[title_internship["title"]]["employmentType"], "Internship")
            self.assertEqual(by_title[title_internship["title"]]["level"], "Internship")
            self.assertEqual(by_title[copywriter["title"]]["employmentType"], "Other")
            self.assertEqual(by_title[copywriter["title"]]["level"], "Unspecified")
            self.assertEqual(by_title[copywriter["title"]]["role"], "Content & Copywriting")
            self.assertEqual(by_title[copywriter["title"]]["city"], "Bengaluru")

        asyncio.run(verify())

    def test_rejects_non_https_or_incomplete_listings(self) -> None:
        self.assertIsNone(normalize_job({"title": "Engineer", "company": "Co", "url": "http://bad.test"}, SOURCE))
        self.assertIsNone(normalize_job({"title": "Engineer", "url": "https://good.test"}, SOURCE))

    def test_preserves_secure_company_logo_urls_and_ignores_insecure_urls(self) -> None:
        job = normalize_job(
            {
                "title": "Engineer",
                "company": "Co",
                "url": "https://example.com/jobs/1",
                "jobLogo": "//cdn.example.com/company.png",
            },
            SOURCE,
        )
        self.assertIsNotNone(job)
        self.assertEqual(job["logo"], "https://cdn.example.com/company.png")

        insecure = normalize_job(
            {
                "title": "Engineer",
                "company": "Co",
                "url": "https://example.com/jobs/2",
                "companyLogoUrl": "http://cdn.example.com/company.png",
            },
            SOURCE,
        )
        self.assertIsNotNone(insecure)
        self.assertNotIn("logo", insecure)

    def test_company_boards_default_to_verified_public_ats_feeds(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            boards = parse_company_boards()

        self.assertEqual(len(boards), 12)
        self.assertEqual(
            {(board["provider"], board["board"]) for board in boards},
            {
                ("greenhouse", "groww"),
                ("greenhouse", "stripe"),
                ("greenhouse", "gitlab"),
                ("greenhouse", "coinbase"),
                ("greenhouse", "datadog"),
                ("lever", "meesho"),
                ("lever", "cred"),
                ("lever", "zeta"),
                ("ashby", "sarvam"),
                ("ashby", "ema"),
                ("ashby", "plane"),
                ("ashby", "aiprise"),
            },
        )

    def test_company_boards_can_be_overridden_or_disabled(self) -> None:
        with patch.dict("os.environ", {"COMPANY_BOARDS": "[]"}):
            self.assertEqual(parse_company_boards(), [])
        custom = '[{"provider":"ashby","board":"example","company":"Example"}]'
        with patch.dict("os.environ", {"COMPANY_BOARDS": custom}):
            self.assertEqual(parse_company_boards(), json.loads(custom))

    def test_ashby_collector_accepts_current_and_legacy_response_shapes(self) -> None:
        board = {"provider": "ashby", "board": "sarvam", "company": "Sarvam"}
        posting = {
            "title": "Software Engineer",
            "location": "Bengaluru, India",
            "descriptionPlain": "Build software.",
            "publishedAt": "2026-11-20T08:30:00Z",
            "employmentType": "FullTime",
            "jobUrl": "https://jobs.ashbyhq.com/sarvam/job-1",
        }

        async def verify() -> None:
            for response in ({"jobs": [posting]}, {"jobPostings": [posting]}):
                with patch("jobboard.pipeline.get_json", new=AsyncMock(return_value=response)):
                    [job] = await collect_ats_board(None, board)
                self.assertEqual(job["title"], "Software Engineer")
                self.assertEqual(job["location"], "Bengaluru, India")
                self.assertEqual(job["sourceEmploymentType"], "FullTime")
                self.assertEqual(job["sources"][0]["url"], "https://jobs.ashbyhq.com/sarvam")

        asyncio.run(verify())

    def test_india_prefilter_uses_posting_location_not_incidental_company_text(self) -> None:
        india_job = make_job()
        unrelated_job = make_job(location="Remote - USA")
        unrelated_job["description"] = "We have offices in India and many global teams."
        remote_india_job = make_job(location="Remote")
        remote_india_job["description"] = "This role is remote and open to applicants in India."

        self.assertTrue(may_be_india_eligible(india_job))
        self.assertFalse(may_be_india_eligible(unrelated_job))
        self.assertTrue(may_be_india_eligible(remote_india_job))

    def test_exact_duplicates_merge_sources_and_keep_richer_description(self) -> None:
        first = make_job()
        second = make_job(url="https://another.example/jobs/1")
        second["description"] = "A more detailed description of the same role."
        second["sources"] = [{"name": "Another", "url": "https://another.example"}]

        [unique] = exact_deduplicate([first, second])

        self.assertEqual(len(unique["sources"]), 2)
        self.assertIn("more detailed", unique["description"])

    def test_exact_duplicates_merge_repeated_urls_even_if_listing_fields_change(self) -> None:
        first = make_job(url="https://example.com/jobs/1?source=first")
        repeated_url = make_job(
            title="Updated Engineer Title",
            location="Remote - India",
            url="https://example.com/jobs/1?source=second",
        )

        [unique] = exact_deduplicate([first, repeated_url])

        self.assertEqual(unique["title"], first["title"])
        self.assertEqual(len(unique["sources"]), 1)

    def test_ai_duplicate_groups_only_merge_similar_company_role_and_location(self) -> None:
        first = make_job()
        duplicate = make_job(
            title="Graduate Software Engineer!",
            location="Bengaluru",
            url="https://another.example/jobs/1",
        )
        duplicate["sources"] = [{"name": "Another", "url": "https://another.example"}]
        unrelated_city = make_job(
            location="Mumbai, India",
            url="https://another.example/jobs/2",
        )

        merged = merge_ai_duplicate_groups(
            [first, duplicate, unrelated_city],
            [[first["id"], duplicate["id"], unrelated_city["id"]]],
        )

        self.assertEqual(len(merged), 2)
        self.assertTrue(any(len(item["sources"]) == 2 for item in merged))

    def test_category_targets_count_overlapping_categories(self) -> None:
        job = make_job()
        job["level"] = "Fresher"
        job["employmentType"] = "Full-time"
        job["city"] = "Bengaluru"

        coverage = quota_coverage([job])

        self.assertEqual(coverage["freshers"]["count"], 1)
        self.assertEqual(coverage["fullTime"]["count"], 1)
        self.assertEqual(coverage["internships"]["count"], 0)
        self.assertFalse(coverage["freshers"]["met"])

    def test_selects_available_free_provider_and_model(self) -> None:
        self.assertEqual(
            select_llm_provider("auto", "groq-key", "gemini-key"),
            ("groq", "openai/gpt-oss-20b", "groq-key"),
        )
        self.assertEqual(
            select_llm_provider("auto", None, "gemini-key"),
            ("gemini", "gemini-3.5-flash-lite", "gemini-key"),
        )
        self.assertEqual(
            select_llm_provider("gemini", "groq-key", "gemini-key"),
            ("gemini", "gemini-3.5-flash-lite", "gemini-key"),
        )

    def test_reads_numbered_groq_keys_in_numeric_order_without_duplicates(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "GROQ_API_KEY": "primary",
                "GROQ_API_KEY_3": "third",
                "GROQ_API_KEY_2": "second",
                "GROQ_API_KEY_4": "primary",
            },
            clear=True,
        ):
            self.assertEqual(configured_groq_api_keys(), ["primary", "second", "third"])

    def test_reads_numbered_gemini_keys_in_numeric_order_without_duplicates(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "GEMINI_API_KEY": "primary",
                "GEMINI_API_KEY_3": "third",
                "GEMINI_API_KEY_2": "second",
                "GEMINI_API_KEY_4": "primary",
            },
            clear=True,
        ):
            self.assertEqual(configured_gemini_api_keys(), ["primary", "second", "third"])

    def test_rotates_gemini_key_after_quota_error(self) -> None:
        async def verify() -> None:
            class RotatedGemini:
                def __init__(self, **kwargs) -> None:
                    self.api_key = kwargs["google_api_key"]

            initial_model = FakeLLM()
            pool = LLMKeyPool(
                initial_model,
                "gemini",
                [],
                ["primary", "backup"],
            )
            fallback_response = FakeStructuredModel(TagBatch)
            with patch("jobboard.pipeline.ChatGoogleGenerativeAI", RotatedGemini):
                with patch(
                    "jobboard.pipeline.structured_output",
                    side_effect=[GeminiQuotaStructuredModel(), fallback_response],
                ):
                    result = await invoke_structured(
                        initial_model,
                        TagBatch,
                        [HumanMessage(content="[]")],
                        LLMRequestPacer(0),
                        pool,
                    )

            self.assertIsInstance(result, TagBatch)
            self.assertEqual(pool.active_provider, "gemini")
            self.assertEqual(pool.gemini_index, 1)
            self.assertEqual(pool.active_model.api_key, "backup")

        asyncio.run(verify())

    def test_detects_daily_token_limit_but_not_minute_limit(self) -> None:
        self.assertTrue(is_groq_daily_token_limit(DailyLimitError()))
        self.assertFalse(is_groq_daily_token_limit(MinuteLimitError()))
        self.assertTrue(is_gemini_quota_error(GeminiQuotaError()))
        self.assertFalse(is_gemini_quota_error(MinuteLimitError()))

    def test_rotates_groq_key_and_retries_only_after_daily_token_limit(self) -> None:
        async def verify() -> None:
            class RotatedGroq:
                def __init__(self, **kwargs) -> None:
                    self.api_key = kwargs["api_key"]

                def with_structured_output(self, schema: type, **kwargs):
                    return FakeStructuredModel(schema)
            initial_model = FakeLLM()
            pool = LLMKeyPool(initial_model, "groq", ["primary", "backup"], [])
            fallback_response = FakeStructuredModel(TagBatch)
            with patch("jobboard.pipeline.ChatGroq", RotatedGroq):
                with patch(
                    "jobboard.pipeline.structured_output",
                    side_effect=[DailyLimitStructuredModel(), fallback_response],
                ):
                    result = await invoke_structured(
                        initial_model,
                        TagBatch,
                        [HumanMessage(content="[]")],
                        LLMRequestPacer(0),
                        pool,
                    )

            self.assertIsInstance(result, TagBatch)
            self.assertEqual(pool.groq_index, 1)
            self.assertEqual(pool.active_model.api_key, "backup")

        asyncio.run(verify())

    def test_falls_back_to_gemini_after_all_groq_keys_reach_daily_limit(self) -> None:
        async def verify() -> None:
            class RotatedGroq:
                def __init__(self, **kwargs) -> None:
                    self.api_key = kwargs["api_key"]

                def with_structured_output(self, schema: type, **kwargs):
                    return FakeStructuredModel(schema)

            class RotatedGemini:
                def __init__(self, **kwargs) -> None:
                    self.api_key = kwargs["google_api_key"]

            initial_model = FakeLLM()
            pool = LLMKeyPool(
                initial_model,
                "groq",
                ["primary", "backup"],
                ["gemini-key"],
            )
            fallback_response = FakeStructuredModel(TagBatch)
            with patch("jobboard.pipeline.ChatGroq", RotatedGroq):
                with patch("jobboard.pipeline.ChatGoogleGenerativeAI", RotatedGemini):
                    with patch(
                        "jobboard.pipeline.structured_output",
                        side_effect=[
                            DailyLimitStructuredModel(),
                            DailyLimitStructuredModel(),
                            fallback_response,
                        ],
                    ) as structured:
                        result = await invoke_structured(
                            initial_model,
                            TagBatch,
                            [HumanMessage(content="[]")],
                            LLMRequestPacer(0),
                            pool,
                        )

            self.assertIsInstance(result, TagBatch)
            self.assertEqual(structured.call_count, 3)
            self.assertEqual(pool.active_provider, "gemini")
            self.assertEqual(pool.gemini_index, 0)
            self.assertEqual(pool.active_model.api_key, "gemini-key")

        asyncio.run(verify())

    def test_groq_daily_limit_without_a_backup_preserves_the_error(self) -> None:
        async def verify() -> None:
            model = FakeLLM()
            pool = LLMKeyPool(model, "groq", ["primary"], [])
            with patch(
                "jobboard.pipeline.structured_output",
                return_value=DailyLimitStructuredModel(),
            ):
                with self.assertRaises(DailyLimitError):
                    await invoke_structured(
                        model,
                        TagBatch,
                        [HumanMessage(content="[]")],
                        LLMRequestPacer(0),
                        pool,
                    )

        asyncio.run(verify())

    def test_rejects_missing_or_paid_provider_configuration(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Set GROQ_API_KEY or GEMINI_API_KEY"):
            select_llm_provider("auto", None, None)
        with self.assertRaisesRegex(ValueError, "LLM_PROVIDER"):
            select_llm_provider("openai", "groq-key", None)
        with self.assertRaisesRegex(RuntimeError, "GEMINI_API_KEY"):
            select_llm_provider("gemini", "groq-key", None)

    def test_groq_uses_strict_json_schema_for_nested_schemas(self) -> None:
        with patch("jobboard.pipeline.ChatGroq", FakeGroq):
            groq = FakeGroq()
            structured_output(groq, DuplicateGroups)
        self.assertEqual(groq.options, {"method": "json_schema", "strict": True})

    def test_gemini_uses_fixed_sampling_defaults_without_temperature(self) -> None:
        class GeminiConstructor:
            def __init__(self, **kwargs) -> None:
                self.options = kwargs

        with patch("jobboard.pipeline.ChatGoogleGenerativeAI", GeminiConstructor):
            with patch.dict(
                "os.environ",
                {"LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "test-key"},
            ):
                from jobboard.pipeline import create_llm

                model = create_llm()

        self.assertNotIn("temperature", model.options)
        self.assertEqual(model.options["google_api_key"], "test-key")

    def test_llm_request_pacer_waits_between_requests(self) -> None:
        async def verify() -> None:
            pacer = LLMRequestPacer(10)
            with patch("jobboard.pipeline.time.monotonic", side_effect=[100, 100, 105, 115]):
                with patch("jobboard.pipeline.asyncio.sleep", new=AsyncMock()) as sleep:
                    await pacer.wait()
                    await pacer.wait()
            sleep.assert_awaited_once_with(5)

        asyncio.run(verify())

    def test_incomplete_tag_batch_retries_as_smaller_batches(self) -> None:
        async def verify() -> None:
            jobs = [
                make_job(url=f"https://example.com/jobs/{index}")
                for index in range(5)
            ]
            response_model = IncompleteOnceModel()
            with patch("jobboard.pipeline.structured_output", return_value=response_model):
                result = await classify_jobs(jobs, FakeLLM(), LLMRequestPacer(0))

            self.assertEqual(len(result), len(jobs))
            self.assertEqual({job["id"] for job in result}, {job["id"] for job in jobs})
            self.assertEqual(response_model.calls, 3)

        asyncio.run(verify())

    def test_ai_dedup_skips_companies_that_appear_in_only_one_source(self) -> None:
        async def verify() -> None:
            llm = FakeLLM()
            jobs = [
                make_job(company="One Source Co", url="https://example.com/1"),
                make_job(
                    company="Another Source Co",
                    url="https://example.com/2",
                ),
            ]
            result = await llm_deduplicate(jobs, llm, LLMRequestPacer(0))

            self.assertEqual(len(result), 2)
            self.assertEqual(llm.structured_models, [])

        asyncio.run(verify())

    def test_ai_dedup_only_sends_companies_found_in_multiple_sources(self) -> None:
        async def verify() -> None:
            first = make_job(url="https://example.com/jobs/1")
            first["sources"] = [{"name": "First source", "url": "https://first.example"}]
            possible_duplicate = make_job(
                title="Junior Software Engineer",
                url="https://second.example/jobs/1",
            )
            possible_duplicate["sources"] = [
                {"name": "Second source", "url": "https://second.example"}
            ]
            unrelated = make_job(
                company="Unrelated Co",
                url="https://unrelated.example/jobs/1",
            )
            llm = FakeLLM()

            result = await llm_deduplicate(
                [first, possible_duplicate, unrelated],
                llm,
                LLMRequestPacer(0),
            )

            self.assertEqual(len(result), 3)
            self.assertEqual(len(llm.structured_models), 1)
            message = next(
                item.content
                for item in llm.structured_models[0].messages
                if isinstance(item, HumanMessage)
            )
            submitted = json.loads(message)
            self.assertEqual({item["id"] for item in submitted}, {first["id"], possible_duplicate["id"]})

        asyncio.run(verify())

    def test_langgraph_publishes_a_tagged_searchable_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            output_path = Path(folder) / "jobs.json"
            llm = FakeLLM()
            with patch(
                "jobboard.pipeline.collect_sources",
                new=AsyncMock(return_value=([make_job()], {"Jobicy": 1}, [])),
            ):
                result = asyncio.run(
                    build_graph(llm).ainvoke({"output_path": str(output_path)})
                )

            published = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(result["report"]["jobCount"], 1)
            self.assertEqual(published["jobs"][0]["city"], "Bengaluru")
            self.assertEqual(published["jobs"][0]["role"], "Engineering")
            self.assertEqual(published["coverage"]["fullTime"]["count"], 1)
            self.assertEqual(
                published["pipelineStats"],
                {
                    "fetched": 1,
                    "indiaCandidates": 1,
                    "afterDeduplication": 1,
                    "classificationCandidates": 1,
                    "indiaEligible": 1,
                    "rejectedAsNotIndiaEligible": 0,
                    "published": 1,
                },
            )
            for model in llm.structured_models:
                system_prompt = next(
                    message.content for message in model.messages if message.type == "system"
                )
                self.assertIn("json", system_prompt.lower())

    def test_failed_ai_batch_keeps_existing_jobs_and_publishes_safe_new_jobs(self) -> None:
        async def verify() -> None:
            with tempfile.TemporaryDirectory() as folder:
                output_path = Path(folder) / "public" / "data" / "jobs.json"
                output_path.parent.mkdir(parents=True)
                pending_path = Path(folder) / ".jobboard-cache" / "pending-jobs.json"
                existing = make_job(
                    title="Existing Software Engineer",
                    company="Existing Co",
                    url="https://existing.example/jobs/1",
                )
                existing.update(
                    {
                        "role": "Engineering",
                        "city": "Bengaluru",
                        "level": "Experienced",
                        "employmentType": "Full-time",
                        "tagSource": "ai",
                    }
                )
                output_path.write_text(
                    json.dumps({"jobs": [existing]}),
                    encoding="utf-8",
                )
                incoming = make_job(
                    title="Junior Software Engineer",
                    company="New Co",
                    url="https://new.example/jobs/1",
                )
                incoming["sources"] = [
                    {"name": "New Co", "url": "https://new.example"}
                ]
                worldwide = make_job(
                    title="Worldwide Product Designer",
                    company="Global Co",
                    location="Worldwide",
                    url="https://global.example/jobs/1",
                )
                with patch(
                    "jobboard.pipeline.collect_sources",
                    new=AsyncMock(
                        return_value=(
                            [incoming, worldwide],
                            {"New Co": 1, "Global Co": 1},
                            [],
                        )
                    ),
                ):
                    result = await build_graph(FailingTagLLM()).ainvoke(
                        {"output_path": str(output_path)}
                    )

                published = json.loads(output_path.read_text(encoding="utf-8"))
                self.assertEqual(result["report"]["jobCount"], 3)
                self.assertEqual(
                    {job["id"] for job in published["jobs"]},
                    {existing["id"], incoming["id"], worldwide["id"]},
                )
                incoming_published = next(
                    job for job in published["jobs"] if job["id"] == incoming["id"]
                )
                self.assertEqual(incoming_published["tagSource"], "rule-based")
                self.assertEqual(incoming_published["city"], "Bengaluru")
                worldwide_published = next(
                    job for job in published["jobs"] if job["id"] == worldwide["id"]
                )
                self.assertEqual(worldwide_published["tagSource"], "rule-based")
                self.assertEqual(worldwide_published["city"], "Remote")
                self.assertEqual(json.loads(pending_path.read_text(encoding="utf-8"))["jobs"], [])

        asyncio.run(verify())


if __name__ == "__main__":
    unittest.main()
