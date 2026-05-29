import pytest
from src.blocker import Blocker
from src.types import BlockingConfig, BlockingStrategy
from helpers import make_processed


def _cfg(*strategies: BlockingStrategy, max_pairs: int = 5000) -> BlockingConfig:
    return BlockingConfig(strategies=list(strategies), max_pairs=max_pairs)


class TestBlocker:
    def test_company_title_produces_pair(self):
        records = [
            make_processed("r1", company_name_normalized="acme", job_title_tokens="software engineer"),
            make_processed("r2", company_name_normalized="acme", job_title_tokens="software developer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE))
        assert len(pairs) == 1
        assert {pairs[0].left_id, pairs[0].right_id} == {"r1", "r2"}

    def test_company_title_pairs_on_shared_token_not_just_first(self):
        # Regression: titles that differ on the first token ("senior" vs "sr") but
        # share later tokens ("software", "engineer") must still co-block.
        records = [
            make_processed("r1", company_name_normalized="acme", job_title_tokens="senior software engineer"),
            make_processed("r2", company_name_normalized="acme", job_title_tokens="sr software engineer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE))
        assert len(pairs) == 1
        assert {pairs[0].left_id, pairs[0].right_id} == {"r1", "r2"}

    def test_no_pair_different_company(self):
        records = [
            make_processed("r1", company_name_normalized="acme", job_title_tokens="engineer"),
            make_processed("r2", company_name_normalized="globex", job_title_tokens="engineer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE))
        assert pairs == []

    def test_company_location_strategy(self):
        records = [
            make_processed("r1", company_name_normalized="acme", location_normalized="london, uk"),
            make_processed("r2", company_name_normalized="acme", location_normalized="london, uk"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_LOCATION))
        assert len(pairs) == 1

    def test_title_function_strategy(self):
        records = [
            make_processed("r1", job_function="engineering", job_title_tokens="software engineer"),
            make_processed("r2", job_function="engineering", job_title_tokens="software developer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.TITLE_FUNCTION))
        assert len(pairs) == 1

    def test_multiple_strategies_deduplicated(self):
        # Both COMPANY_TITLE and TITLE_FUNCTION would produce (r1, r2), but only once
        records = [
            make_processed(
                "r1",
                company_name_normalized="acme",
                job_title_tokens="software engineer",
                job_function="engineering",
            ),
            make_processed(
                "r2",
                company_name_normalized="acme",
                job_title_tokens="software engineer",
                job_function="engineering",
            ),
        ]
        pairs = Blocker().generate_pairs(
            records,
            _cfg(BlockingStrategy.COMPANY_TITLE, BlockingStrategy.TITLE_FUNCTION),
        )
        assert len(pairs) == 1

    def test_max_pairs_exceeded_raises(self):
        records = [
            make_processed(f"r{i}", company_name_normalized="acme", job_title_tokens="engineer")
            for i in range(10)
        ]
        with pytest.raises(ValueError, match="max_pairs"):
            Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE, max_pairs=1))

    def test_empty_records_returns_empty(self):
        assert Blocker().generate_pairs([], _cfg(BlockingStrategy.COMPANY_TITLE)) == []

    def test_single_record_returns_empty(self):
        records = [make_processed("r1")]
        assert Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE)) == []

    def test_blocking_key_prefix_company_title(self):
        records = [
            make_processed("r1", company_name_normalized="acme", job_title_tokens="engineer"),
            make_processed("r2", company_name_normalized="acme", job_title_tokens="engineer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE))
        assert pairs[0].blocking_key.startswith("ct:")

    def test_blocking_key_prefix_company_location(self):
        records = [
            make_processed("r1", company_name_normalized="acme", location_normalized="london, uk"),
            make_processed("r2", company_name_normalized="acme", location_normalized="london, uk"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_LOCATION))
        assert pairs[0].blocking_key.startswith("cl:")

    def test_blocking_key_prefix_title_function(self):
        records = [
            make_processed("r1", job_function="engineering", job_title_tokens="software engineer"),
            make_processed("r2", job_function="engineering", job_title_tokens="software engineer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.TITLE_FUNCTION))
        assert pairs[0].blocking_key.startswith("tf:")

    def test_pairs_are_ordered_canonical(self):
        records = [
            make_processed("r2", company_name_normalized="acme", job_title_tokens="engineer"),
            make_processed("r1", company_name_normalized="acme", job_title_tokens="engineer"),
        ]
        pairs = Blocker().generate_pairs(records, _cfg(BlockingStrategy.COMPANY_TITLE))
        assert pairs[0].left_id < pairs[0].right_id
