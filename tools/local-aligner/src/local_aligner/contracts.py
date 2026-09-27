from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StableToken(StrictModel):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)


class SampleRange(StrictModel):
    start_sample: int = Field(ge=0)
    end_sample: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_order(self) -> "SampleRange":
        if self.end_sample <= self.start_sample:
            raise ValueError("end_sample must be greater than start_sample")
        return self


class AlignOptions(StrictModel):
    device: str = "cuda"
    return_char_alignments: Literal[True] = True
    interpolate_method: Literal["nearest", "linear", "ignore"] = "nearest"
    model_dir: str | None = None
    model_cache_only: bool = False


class AlignRequest(StrictModel):
    schema_version: Literal["1"]
    backend: Literal["whisperx"]
    audio_path: Path
    language: Literal["zh"] = "zh"
    text: str = Field(min_length=1)
    stable_tokens: list[StableToken] = Field(min_length=1)
    segment: SampleRange
    options: AlignOptions = Field(default_factory=AlignOptions)

    @model_validator(mode="after")
    def validate_tokens(self) -> "AlignRequest":
        ids = [token.id for token in self.stable_tokens]
        if len(ids) != len(set(ids)):
            raise ValueError("stable token IDs must be unique")
        return self


class BackendIdentity(StrictModel):
    name: Literal["whisperx"]
    model: str
    model_revision: str
    package_version: str
    device: str
    config: dict[str, object]


class AlignedToken(StrictModel):
    token_id: str
    start_sample: int = Field(ge=0)
    end_sample: int = Field(gt=0)
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def validate_order(self) -> "AlignedToken":
        if self.end_sample <= self.start_sample:
            raise ValueError("token end_sample must be greater than start_sample")
        return self


class UnmatchedRange(StrictModel):
    from_token_id: str
    to_token_id: str
    reason: str


class AlignResult(StrictModel):
    schema_version: Literal["1"] = "1"
    backend: BackendIdentity
    tokens: list[AlignedToken]
    unmatched_ranges: list[UnmatchedRange]
    warnings: list[str]
    audio_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    text_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
