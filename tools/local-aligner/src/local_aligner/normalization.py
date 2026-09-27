from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

from .contracts import AlignedToken, StableToken, UnmatchedRange

SPEECH_CONTROL_PATTERN = re.compile(
    r"<#[0-9]+(?:\.[0-9]+)?#>|\((?:breath|sighs|laughs|cough|sniffs?|groans?)\)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class TimedCharacter:
    character: str
    start_sample: int
    end_sample: int
    confidence: float | None


def strip_speech_controls(text: str) -> str:
    return SPEECH_CONTROL_PATTERN.sub("", text)


def comparable_characters(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", strip_speech_controls(text)).casefold()
    return [
        character
        for character in normalized
        if not unicodedata.category(character).startswith(("P", "S", "Z"))
        and not character.isspace()
    ]


def normalize_alignment_text(text: str) -> str:
    return "".join(comparable_characters(text))


def expand_aligned_characters(
    aligned_chars: Iterable[dict[str, object]],
    sample_rate: int,
) -> list[TimedCharacter]:
    output: list[TimedCharacter] = []
    for item in aligned_chars:
        characters = comparable_characters(str(item.get("char", "")))
        start = item.get("start")
        end = item.get("end")
        if not characters or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        start_sample = round(float(start) * sample_rate)
        end_sample = round(float(end) * sample_rate)
        if end_sample <= start_sample:
            continue
        duration = end_sample - start_sample
        raw_score = item.get("score")
        confidence = float(raw_score) if isinstance(raw_score, (int, float)) else None
        for index, character in enumerate(characters):
            output.append(
                TimedCharacter(
                    character=character,
                    start_sample=start_sample + duration * index // len(characters),
                    end_sample=start_sample + (duration * (index + 1) + len(characters) - 1) // len(characters),
                    confidence=confidence,
                )
            )
    return output


def map_characters_to_stable_tokens(
    stable_tokens: list[StableToken],
    aligned_chars: Iterable[dict[str, object]],
    sample_rate: int,
    segment_start_sample: int,
    segment_end_sample: int,
) -> tuple[list[AlignedToken], list[UnmatchedRange], list[str]]:
    timed_characters = expand_aligned_characters(aligned_chars, sample_rate)
    mapped: dict[int, list[TimedCharacter]] = {}
    cursor = 0
    missing_tokens: list[int] = []

    for token_index, token in enumerate(stable_tokens):
        token_characters = comparable_characters(token.text)
        matched: list[TimedCharacter] = []
        for character in token_characters:
            found = _find_next_character(timed_characters, character, cursor)
            if found < 0:
                continue
            matched.append(timed_characters[found])
            cursor = found + 1
        if len(matched) == len(token_characters) and matched:
            mapped[token_index] = matched
        else:
            missing_tokens.append(token_index)

    tokens: list[AlignedToken] = []
    for token_index, timings in mapped.items():
        start_sample = max(segment_start_sample, timings[0].start_sample)
        end_sample = min(segment_end_sample, timings[-1].end_sample)
        if end_sample <= start_sample:
            missing_tokens.append(token_index)
            continue
        scores = [item.confidence for item in timings if item.confidence is not None]
        tokens.append(
            AlignedToken(
                token_id=stable_tokens[token_index].id,
                start_sample=start_sample,
                end_sample=end_sample,
                confidence=sum(scores) / len(scores) if scores else None,
            )
        )

    unmatched = _group_unmatched(stable_tokens, sorted(set(missing_tokens)))
    warnings = []
    if unmatched:
        warnings.append(f"{len(missing_tokens)} stable tokens could not be fully aligned")
    return tokens, unmatched, warnings


def _find_next_character(values: list[TimedCharacter], character: str, start_index: int) -> int:
    for index in range(start_index, len(values)):
        if values[index].character == character:
            return index
    return -1


def _group_unmatched(tokens: list[StableToken], indices: list[int]) -> list[UnmatchedRange]:
    if not indices:
        return []
    groups: list[tuple[int, int]] = []
    start = previous = indices[0]
    for index in indices[1:]:
        if index == previous + 1:
            previous = index
            continue
        groups.append((start, previous))
        start = previous = index
    groups.append((start, previous))
    return [
        UnmatchedRange(
            from_token_id=tokens[start_index].id,
            to_token_id=tokens[end_index].id,
            reason="character_alignment_missing",
        )
        for start_index, end_index in groups
    ]
