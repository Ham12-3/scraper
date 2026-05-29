import pytest
from src.preprocessor import Preprocessor, _to_ascii, _company_name, _title_tokens, _location, _skills
from helpers import make_record


class TestToAscii:
    def test_latin_accents_stripped(self):
        assert _to_ascii("café") == "cafe"

    def test_ascii_unchanged(self):
        assert _to_ascii("hello") == "hello"

    def test_umlauts_stripped(self):
        result = _to_ascii("Müller")
        assert "u" in result.lower()


class TestCompanyName:
    def test_strips_inc(self):
        assert "inc" not in _company_name("Acme Inc")

    def test_strips_llc(self):
        assert "llc" not in _company_name("Acme LLC")

    def test_strips_ltd(self):
        assert "ltd" not in _company_name("Acme Ltd")

    def test_strips_corp(self):
        assert "corp" not in _company_name("Acme Corp")

    def test_lowercases(self):
        assert _company_name("Acme") == "acme"

    def test_collapses_whitespace(self):
        result = _company_name("Acme   Corp")
        assert "  " not in result


class TestTitleTokens:
    def test_removes_stop_words(self):
        tokens = _title_tokens("Head of Engineering")
        assert "of" not in tokens.split()

    def test_lowercases(self):
        assert _title_tokens("Software Engineer").islower()

    def test_keeps_meaningful_words(self):
        tokens = _title_tokens("Software Engineer")
        assert "software" in tokens
        assert "engineer" in tokens


class TestLocation:
    def test_city_and_country(self):
        result = _location("London", "UK")
        assert "london" in result
        assert "uk" in result

    def test_none_city(self):
        result = _location(None, "UK")
        assert "uk" in result
        assert result.startswith("uk")

    def test_none_country(self):
        result = _location("London", None)
        assert "london" in result

    def test_both_none_returns_empty(self):
        assert _location(None, None) == ""


class TestSkills:
    def test_normalises_case(self):
        result = _skills(["Python", "SQL"])
        assert "python" in result
        assert "sql" in result

    def test_deduplicates(self):
        result = _skills(["python", "Python"])
        assert result.count("python") == 1

    def test_sorted(self):
        result = _skills(["sql", "python"])
        parts = result.split()
        assert parts == sorted(parts)

    def test_strips_blanks(self):
        result = _skills(["python", "  ", ""])
        assert "python" in result


class TestPreprocessor:
    def test_basic_record(self, now):
        rec = make_record("r1", now=now)
        result = Preprocessor().preprocess([rec])
        assert len(result) == 1
        pr = result[0]
        assert pr.record_id == "r1"
        assert pr.job_title_tokens
        assert pr.company_name_normalized

    def test_skips_bad_record_keeps_good(self, now):
        good = make_record("good", now=now)
        # Inject a bad object that will cause an AttributeError
        class BadRecord:
            record_id = "bad"
            job_title = None  # _title_tokens will fail
            company_name = "Acme"
            location_city = None
            location_country = None
            skills = []
            seniority_level = "senior"
            job_function = "engineering"
        result = Preprocessor().preprocess([good, BadRecord()])  # type: ignore[list-item]
        assert any(r.record_id == "good" for r in result)

    def test_empty_input_returns_empty(self):
        assert Preprocessor().preprocess([]) == []

    def test_batch_of_three(self, now):
        recs = [make_record(f"r{i}", now=now) for i in range(3)]
        result = Preprocessor().preprocess(recs)
        assert len(result) == 3
        assert [r.record_id for r in result] == ["r0", "r1", "r2"]

    def test_location_combined(self, now):
        rec = make_record("r1", location_city="Berlin", location_country="Germany", now=now)
        pr = Preprocessor().preprocess([rec])[0]
        assert "berlin" in pr.location_normalized
        assert "germany" in pr.location_normalized

    def test_skills_sorted_and_normalised(self, now):
        rec = make_record("r1", skills=["SQL", "Python", "python"], now=now)
        pr = Preprocessor().preprocess([rec])[0]
        parts = pr.skills_normalized.split()
        assert parts == sorted(parts)
        assert parts.count("python") == 1
