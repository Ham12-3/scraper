from bs4 import BeautifulSoup, Tag

from .types import (
    CssSelectorSet,
    ExtractionStrategy,
    ParserConfig,
    RawJobPosting,
)


def _first_text(soup: BeautifulSoup, selectors: list[str]) -> str | None:
    """Try each selector in order; return the stripped text of the first match."""
    for selector in selectors:
        try:
            node = soup.select_one(selector)
        except Exception:
            continue
        if node and node.get_text(strip=True):
            return node.get_text(separator=" ", strip=True)
    return None


def _all_texts(soup: BeautifulSoup, selectors: list[str]) -> list[str]:
    """Return stripped text from every element matched by any selector."""
    results: list[str] = []
    seen: set[str] = set()
    for selector in selectors:
        try:
            nodes = soup.select(selector)
        except Exception:
            continue
        for node in nodes:
            text = node.get_text(separator=" ", strip=True)
            if text and text not in seen:
                seen.add(text)
                results.append(text)
    return results


def _try_selector_set(
    soup: BeautifulSoup, selector_set: CssSelectorSet
) -> RawJobPosting | None:
    posting = RawJobPosting(
        job_title=_first_text(soup, selector_set.job_title),
        company_name=_first_text(soup, selector_set.company_name),
        location_raw=_first_text(soup, selector_set.location),
        skills_raw=_all_texts(soup, selector_set.skills),
        seniority_raw=_first_text(soup, selector_set.seniority_level),
        posted_date_raw=_first_text(soup, selector_set.posted_date),
    )
    return None if posting.is_empty() else posting


class CssExtractor:
    strategy_name: ExtractionStrategy = ExtractionStrategy.CSS_SELECTORS

    def extract(self, html: str, config: ParserConfig) -> RawJobPosting | None:
        if not config.selector_sets:
            return None

        soup = BeautifulSoup(html, "lxml")

        for selector_set in config.selector_sets:
            result = _try_selector_set(soup, selector_set)
            if result is not None:
                return result

        return None
