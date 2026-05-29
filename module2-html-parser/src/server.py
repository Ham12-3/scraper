"""
Flask HTTP server wrapping HtmlParser.
POST /parse  ->  ParseResultMessage JSON (Module 3 compatible)
GET  /health ->  {"status": "ok"}

The app is built via the ``create_app`` factory so it can be tested with an
injected parser (no Anthropic client / env vars required). gunicorn loads it
through the ``src.server:create_app()`` factory entry point.
"""
import os
from datetime import datetime, timezone

import anthropic
from flask import Flask, jsonify, request as flask_request

from src.config_loader import load_config
from src.parser import HtmlParser
from src.types import IParser, ParseError, ParseRequest


def _build_default_parser() -> IParser:
    """Wire up the real parser from environment config (used in production)."""
    config = load_config()
    # The Anthropic client reads ANTHROPIC_API_KEY from the environment. Apply the
    # configured per-request timeout so the LLM fallback can't hang a worker.
    client = anthropic.Anthropic(timeout=config.llm.timeout_seconds)
    return HtmlParser.create(config, client)


def create_app(parser: IParser | None = None) -> Flask:
    """
    Build the Flask app. If ``parser`` is None, the real env-configured parser is
    constructed; tests inject a fake parser instead.
    """
    if parser is None:
        parser = _build_default_parser()

    app = Flask(__name__)

    @app.post("/parse")
    def parse():
        body = flask_request.get_json(force=True)
        req = ParseRequest(
            task_id=body.get("task_id", ""),
            url=body.get("url", ""),
            html=body.get("html", ""),
        )
        result = parser.parse(req)

        if isinstance(result, ParseError):
            return jsonify({"error": result.error_code.value, "message": result.message}), 422

        job = result.posting
        return jsonify({
            "taskId": req.task_id,
            "url": req.url,
            "resolvedUrl": req.url,
            "jobTitle": job.job_title,
            "jobFunction": job.job_function.value,
            "companyName": job.company_name,
            "locationCity": job.location.city,
            "locationCountry": job.location.country,
            "skills": job.skills,
            "seniorityLevel": job.seniority_level.value,
            "postedDate": job.posted_date.isoformat() if job.posted_date else None,
            "extractionStrategy": result.strategy_used.value,
            "processedAt": datetime.now(timezone.utc).isoformat(),
            "totalDurationMs": 0,
        })

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    return app


if __name__ == "__main__":
    port = int(os.environ.get("PARSER_PORT", "8080"))
    create_app().run(host="0.0.0.0", port=port)
