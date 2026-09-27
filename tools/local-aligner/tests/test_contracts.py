import json

import pytest
from pydantic import ValidationError

from local_aligner.contracts import AlignRequest


def request_payload() -> dict[str, object]:
    return {
        "schema_version": "1",
        "backend": "whisperx",
        "audio_path": "audio.wav",
        "language": "zh",
        "text": "重庆",
        "stable_tokens": [
            {"id": "VO001:T0001", "text": "重"},
            {"id": "VO001:T0002", "text": "庆"},
        ],
        "segment": {"start_sample": 0, "end_sample": 48_000},
        "options": {"device": "cuda", "return_char_alignments": True},
    }


def test_request_contract_is_strict() -> None:
    payload = request_payload()
    request = AlignRequest.model_validate_json(json.dumps(payload))
    assert request.language == "zh"
    payload["secret"] = "not allowed"
    with pytest.raises(ValidationError):
        AlignRequest.model_validate(payload)


def test_duplicate_token_ids_are_rejected() -> None:
    payload = request_payload()
    payload["stable_tokens"][1]["id"] = "VO001:T0001"
    with pytest.raises(ValidationError):
        AlignRequest.model_validate(payload)
