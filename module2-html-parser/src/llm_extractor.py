"""
LLM extraction layer.

Strips the HTML to minimal readable text, then calls claude-haiku-4-5
with a structured output prompt. Parses the JSON response into an
LLMExtractionResult. Returns None on any failure — never raises.
"""

import json
import re
import time
from typing import Any

import anthropic
from bs4 import BeautifulSoup

from .logger import Logger
from .types import (
    ExtractionStrategy,
    LLMExtractionResult,
    Location,
    ParserConfig,
    ParseErrorCode,
    RawJobPosting,
    SeniorityLevel,
)

_STRIP_TAGS = {
    "script", "style", "noscript", "svg", "img",
    "video", "audio", "iframe", "canvas", "figure",
}

_COLLAPSE_WHITESPACE = re.compile(r"\s{2,}")


def _strip_html(html: str, max_chars: int) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(_STRIP_TAGS):
        tag.decompose()

    text = soup.get_text(separator="\n")
    # Collapse runs of blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = _COLLAPSE_WHITESPACE.sub(" ", text).strip()

    return text[:max_chars]


_SYSTEM_PROMPT = """\
You are a precise data extraction assistant. Extract job posting information \
from the provided text and return it as a single JSON object matching this schema:

{
  "job_title": "string — exact job title as listed",
  "company_name": "string — name of the hiring company",
  "location": {
    "city": "string or null",
    "country": "string or null"
  },
  "skills": ["array of skill strings"],
  "seniority_level": "one of: intern, junior, mid, senior, staff, principal, \
lead, manager, director, vp, c_suite, unknown"
}

Rules:
- Return ONLY valid JSON. No prose, no markdown, no code fences.
- If a field cannot be determined, use null for strings and [] for arrays.
- For seniority_level, infer from the job title if not explicitly stated.
- Normalise country names to their full English name (e.g. "US" → "United States").
"""


class LLMExtractor:
    strategy_name: ExtractionStrategy = ExtractionStrategy.LLM

    def __init__(self, client: anthropic.Anthropic, logger: Logger) -> None:
        self._client = client
        self._logger = logger

    def extract(self, html: str, config: ParserConfig) -> RawJobPosting | None:
        stripped = _strip_html(html, config.llm.max_html_chars)
        if not stripped:
            return None

        start = time.monotonic()
        raw_json: str | None = None

        try:
            response = self._client.messages.create(
                model=config.llm.model,
                max_tokens=config.llm.max_tokens,
                temperature=config.llm.temperature,
                system=_SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": f"Extract job posting data from this text:\n\n{stripped}",
                    }
                ],
                timeout=config.llm.timeout_seconds,
            )
        except anthropic.APIConnectionError as exc:
            self._logger.error(
                "llm.api_error",
                error_code=ParseErrorCode.LLM_API_ERROR,
                strategy=ExtractionStrategy.LLM,
                exc=exc,
            )
            return None
        except anthropic.RateLimitError as exc:
            self._logger.error(
                "llm.rate_limited",
                error_code=ParseErrorCode.LLM_API_ERROR,
                strategy=ExtractionStrategy.LLM,
                exc=exc,
            )
            return None
        except anthropic.APIStatusError as exc:
            self._logger.error(
                "llm.api_status_error",
                error_code=ParseErrorCode.LLM_API_ERROR,
                strategy=ExtractionStrategy.LLM,
                exc=exc,
                status_code=exc.status_code,
            )
            return None

        duration_ms = (time.monotonic() - start) * 1000

        # Extract text content from the response
        for block in response.content:
            if block.type == "text":
                raw_json = block.text.strip()
                break

        if not raw_json:
            self._logger.error(
                "llm.empty_response",
                error_code=ParseErrorCode.LLM_PARSE_ERROR,
                strategy=ExtractionStrategy.LLM,
                duration_ms=duration_ms,
            )
            return None

        # Strip markdown code fences if the model added them despite instructions
        raw_json = re.sub(r"^```(?:json)?\s*", "", raw_json)
        raw_json = re.sub(r"\s*```$", "", raw_json).strip()

        try:
            data: dict[str, Any] = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            self._logger.error(
                "llm.json_decode_error",
                error_code=ParseErrorCode.LLM_PARSE_ERROR,
                strategy=ExtractionStrategy.LLM,
                exc=exc,
                raw_response=raw_json[:200],
            )
            return None

        try:
            result = LLMExtractionResult.model_validate(data)
        except Exception as exc:
            self._logger.error(
                "llm.schema_validation_error",
                error_code=ParseErrorCode.LLM_PARSE_ERROR,
                strategy=ExtractionStrategy.LLM,
                exc=exc,
            )
            return None

        self._logger.info(
            "llm.extraction_complete",
            strategy=ExtractionStrategy.LLM,
            duration_ms=round(duration_ms, 1),
        )

        return _llm_result_to_raw(result)


def _llm_result_to_raw(result: LLMExtractionResult) -> RawJobPosting:
    location_parts = [
        p for p in [result.location.city, result.location.country] if p
    ]
    return RawJobPosting(
        job_title=result.job_title or None,
        company_name=result.company_name or None,
        location_raw=", ".join(location_parts) or None,
        skills_raw=result.skills,
        seniority_raw=result.seniority_level.value
        if result.seniority_level != SeniorityLevel.UNKNOWN
        else None,
    )
