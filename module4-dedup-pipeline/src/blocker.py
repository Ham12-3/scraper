from collections import defaultdict

from .types import BlockingConfig, BlockingStrategy, CandidatePair, ProcessedRecord


def _first_token(text: str) -> str:
    parts = text.split()
    return parts[0] if parts else ""


def _tokens(text: str) -> list[str]:
    """Unique tokens in stable order — used to key a record into one block per token."""
    seen: set[str] = set()
    out: list[str] = []
    for part in text.split():
        if part not in seen:
            seen.add(part)
            out.append(part)
    return out


def _emit_pairs(
    groups: dict[str, list[str]],
    key_prefix: str,
    seen: set[tuple[str, str]],
    result: list[CandidatePair],
    max_pairs: int,
) -> None:
    for block_key, ids in groups.items():
        deduped = sorted(set(ids))
        for i in range(len(deduped)):
            for j in range(i + 1, len(deduped)):
                canonical = (deduped[i], deduped[j])
                if canonical in seen:
                    continue
                seen.add(canonical)
                result.append(
                    CandidatePair(
                        left_id=deduped[i],
                        right_id=deduped[j],
                        blocking_key=f"{key_prefix}:{block_key}",
                    )
                )
                if len(result) > max_pairs:
                    raise ValueError(
                        f"Candidate pair count exceeded max_pairs={max_pairs}. "
                        "Reduce batch_size or narrow blocking strategies."
                    )


def _company_title_groups(records: list[ProcessedRecord]) -> dict[str, list[str]]:
    # Anchor on the company's first token (stable after suffix stripping), but key
    # on EACH title token so records whose titles differ in word order or wording
    # (e.g. "Senior Software Engineer" vs "Sr Software Engineer") still co-block on
    # a shared token like "software"/"engineer".
    groups: dict[str, list[str]] = defaultdict(list)
    for r in records:
        c = _first_token(r.company_name_normalized)
        if not c:
            continue
        for t in _tokens(r.job_title_tokens):
            groups[f"{c}|{t}"].append(r.record_id)
    return groups


def _company_location_groups(records: list[ProcessedRecord]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for r in records:
        c = _first_token(r.company_name_normalized)
        loc = r.location_normalized[:20]
        if c and loc:
            groups[f"{c}|{loc}"].append(r.record_id)
    return groups


def _title_function_groups(records: list[ProcessedRecord]) -> dict[str, list[str]]:
    # Key on (job_function, each title token) for the same reason as company_title.
    groups: dict[str, list[str]] = defaultdict(list)
    for r in records:
        func = r.job_function
        if not func:
            continue
        for t in _tokens(r.job_title_tokens):
            groups[f"{func}|{t}"].append(r.record_id)
    return groups


_STRATEGY_BUILDERS = {
    BlockingStrategy.COMPANY_TITLE: (_company_title_groups, "ct"),
    BlockingStrategy.COMPANY_LOCATION: (_company_location_groups, "cl"),
    BlockingStrategy.TITLE_FUNCTION: (_title_function_groups, "tf"),
}


class Blocker:
    """
    Implements IBlocker. Generates candidate pairs using one or more blocking
    strategies. Deduplicates pairs across strategies. Raises ValueError if
    max_pairs is exceeded.
    """

    def generate_pairs(
        self,
        records: list[ProcessedRecord],
        config: BlockingConfig,
    ) -> list[CandidatePair]:
        seen: set[tuple[str, str]] = set()
        result: list[CandidatePair] = []

        for strategy in config.strategies:
            build_groups, prefix = _STRATEGY_BUILDERS[strategy]
            groups = build_groups(records)
            _emit_pairs(groups, prefix, seen, result, config.max_pairs)

        return result
