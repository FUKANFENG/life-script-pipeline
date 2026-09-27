from local_aligner.contracts import StableToken
from local_aligner.normalization import (
    map_characters_to_stable_tokens,
    normalize_alignment_text,
    strip_speech_controls,
)


def test_controls_and_punctuation_do_not_enter_alignment_text() -> None:
    text = "重庆，KinoCut 3号。<#0.5#>(breath)出发！"
    assert strip_speech_controls(text) == "重庆，KinoCut 3号。出发！"
    assert normalize_alignment_text(text) == "重庆kinocut3号出发"


def test_character_alignment_maps_chinese_english_and_numbers_to_stable_tokens() -> None:
    tokens = [
        StableToken(id="VO001:T0001", text="重"),
        StableToken(id="VO001:T0002", text="庆"),
        StableToken(id="VO001:T0003", text="KinoCut"),
        StableToken(id="VO001:T0004", text="3"),
    ]
    text = "重庆KinoCut3"
    chars = [
        {"char": character, "start": 0.2 + index * 0.05, "end": 0.25 + index * 0.05, "score": 0.98}
        for index, character in enumerate(text)
    ]
    aligned, unmatched, warnings = map_characters_to_stable_tokens(
        tokens,
        chars,
        sample_rate=48_000,
        segment_start_sample=0,
        segment_end_sample=48_000,
    )
    assert [token.token_id for token in aligned] == [token.id for token in tokens]
    assert aligned[0].start_sample == 9_600
    assert aligned[-1].end_sample < 48_000
    assert unmatched == []
    assert warnings == []


def test_unmatched_characters_are_reported_without_fabricated_timing() -> None:
    tokens = [
        StableToken(id="VO001:T0001", text="重"),
        StableToken(id="VO001:T0002", text="庆"),
        StableToken(id="VO001:T0003", text="行"),
    ]
    chars = [
        {"char": "重", "start": 0.5, "end": 0.7, "score": 0.9},
        {"char": "庆", "start": 0.7, "end": 0.9, "score": 0.9},
    ]
    aligned, unmatched, warnings = map_characters_to_stable_tokens(
        tokens,
        chars,
        sample_rate=48_000,
        segment_start_sample=0,
        segment_end_sample=96_000,
    )
    assert [token.token_id for token in aligned] == ["VO001:T0001", "VO001:T0002"]
    assert unmatched[0].from_token_id == "VO001:T0003"
    assert unmatched[0].to_token_id == "VO001:T0003"
    assert warnings


def test_leading_and_trailing_silence_are_preserved_as_token_boundaries() -> None:
    tokens = [StableToken(id="VO001:T0001", text="山")]
    aligned, unmatched, _ = map_characters_to_stable_tokens(
        tokens,
        [{"char": "山", "start": 0.8, "end": 1.2, "score": 0.95}],
        sample_rate=48_000,
        segment_start_sample=0,
        segment_end_sample=96_000,
    )
    assert unmatched == []
    assert aligned[0].start_sample == 38_400
    assert aligned[0].end_sample == 57_600
