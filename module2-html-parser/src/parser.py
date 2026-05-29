"""
Top-level parser pipeline. Orchestrates the strategy cascade and normalisation.
Never raises — all failure paths return ParseError.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import anthropic

from .css_extractor import CssExtractor
from .heuristic_extractor import HeuristicExtractor
from .llm_extractor import LLMExtractor
from .logger import Logger
from .normaliser import Normaliser
from .types import (
    ExtractionStrategy,
    IExtractionStrategy,
    ParseError,
    ParseErrorCode,
    ParseRequest,
    ParseResult,
    ParserConfig,
    RawJobPosting,
)


class HtmlParser:
    """
    Implements IParser. Runs strategies in config.strategy_order order and
    normalises the first successful result into a ParseResult.
    On any failure, returns a ParseError instead of raising.
    """

    def __init__(
        self,
        config: ParserConfig,
        strategies: dict[ExtractionStrategy, IExtractionStrategy],
        normaliser: Normaliser,
        logger: Logger,
    ) -> None:
        self._config = config
        self._strategies = strategies
        self._normaliser = normaliser
        self._logger = logger

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def create(cls, config: ParserConfig, anthropic_client: anthropic.Anthropic) -> "HtmlParser":
        """Wire up all strategies and return a ready-to-use HtmlParser."""
        logger = Logger()
        strategies: dict[ExtractionStrategy, IExtractionStrategy] = {
            ExtractionStrategy.CSS_SELECTORS: CssExtractor(),
            ExtractionStrategy.HEURISTIC: HeuristicExtractor(),
            ExtractionStrategy.LLM: LLMExtractor(client=anthropic_client, logger=logger),
        }
        return cls(
            config=config,
            strategies=strategies,
            normaliser=Normaliser(),
            logger=logger,
        )

    # ------------------------------------------------------------------
    # Core pipeline
    # ------------------------------------------------------------------

    def parse(self, request: ParseRequest) -> ParseResult | ParseError:
        # Validate minimum HTML length (non-whitespace characters)
        non_ws_len = len("".join(request.html.split()))
        if non_ws_len < self._config.min_html_length:
            self._logger.error(
                "parser.html_too_short",
                task_id=request.task_id,
                error_code=ParseErrorCode.HTML_TOO_SHORT,
                html_length=non_ws_len,
                min_required=self._config.min_html_length,
            )
            return ParseError(
                task_id=request.task_id,
                url=request.url,
                error_code=ParseErrorCode.HTML_TOO_SHORT,
                message=(
                    f"HTML has {non_ws_len} non-whitespace characters; "
                    f"minimum required is {self._config.min_html_length}"
                ),
                strategies_attempted=[],
            )

        # force_strategy overrides the configured order
        order: list[ExtractionStrategy] = (
            [request.force_strategy]
            if request.force_strategy is not None
            else list(self._config.strategy_order)
        )

        attempted: list[ExtractionStrategy] = []
        raw: RawJobPosting | None = None
        winning_strategy: ExtractionStrategy | None = None

        for strategy_name in order:
            strategy = self._strategies.get(strategy_name)
            if strategy is None:
                self._logger.warn(
                    "parser.strategy_not_registered",
                    task_id=request.task_id,
                    strategy=strategy_name,
                )
                continue

            attempted.append(strategy_name)
            start = time.monotonic()

            try:
                result = strategy.extract(request.html, self._config)
            except Exception as exc:
                self._logger.error(
                    "parser.strategy_raised",
                    task_id=request.task_id,
                    error_code=ParseErrorCode.ALL_STRATEGIES_FAILED,
                    strategy=strategy_name,
                    exc=exc,
                )
                continue

            duration_ms = (time.monotonic() - start) * 1000

            if result is not None and not result.is_empty():
                self._logger.info(
                    "parser.strategy_succeeded",
                    task_id=request.task_id,
                    strategy=strategy_name,
                    duration_ms=round(duration_ms, 1),
                )
                raw = result
                winning_strategy = strategy_name
                break

            self._logger.debug(
                "parser.strategy_missed",
                task_id=request.task_id,
                strategy=strategy_name,
                duration_ms=round(duration_ms, 1),
            )

        if raw is None or winning_strategy is None:
            self._logger.error(
                "parser.all_strategies_failed",
                task_id=request.task_id,
                error_code=ParseErrorCode.ALL_STRATEGIES_FAILED,
            )
            return ParseError(
                task_id=request.task_id,
                url=request.url,
                error_code=ParseErrorCode.ALL_STRATEGIES_FAILED,
                message="All extraction strategies failed to produce a result",
                strategies_attempted=attempted,
            )

        try:
            posting = self._normaliser.normalise(raw)
        except ValueError as exc:
            self._logger.error(
                "parser.normalisation_failed",
                task_id=request.task_id,
                error_code=ParseErrorCode.NORMALISATION_ERROR,
                exc=exc,
            )
            return ParseError(
                task_id=request.task_id,
                url=request.url,
                error_code=ParseErrorCode.NORMALISATION_ERROR,
                message=str(exc),
                strategies_attempted=attempted,
            )

        return ParseResult(
            task_id=request.task_id,
            url=request.url,
            strategy_used=winning_strategy,
            posting=posting,
            extracted_at=datetime.now(tz=timezone.utc).isoformat(),
        )
