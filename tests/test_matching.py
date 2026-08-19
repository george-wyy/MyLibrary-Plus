from mylibrary.schemas import PaperCandidate
from mylibrary.services.matching import merge_candidates, normalize_title, score_candidate


def test_normalize_and_merge_same_work() -> None:
    first = PaperCandidate(title="Attention Is All You Need", source="arxiv", year=2017, arxiv_id="1706.03762")
    second = PaperCandidate(title="Attention Is All You Need", source="openalex", year=2017, doi="10.48550/arxiv.1706.03762")

    merged = merge_candidates([first, second])

    assert normalize_title("Attention: Is All You Need!") == "attention is all you need"
    assert len(merged) == 1
    assert merged[0].doi == "10.48550/arxiv.1706.03762"
    assert merged[0].sources == ["arxiv", "openalex"]
    assert score_candidate("Attention Is All You Need", merged[0]) >= 0.90
