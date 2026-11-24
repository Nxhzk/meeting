"""
Transcription service package.

Speech-to-text goes through Alibaba Cloud ASR, the only connector. The
connector layer remains so the rest of the app asks the registry for the active
connector, its name and its capabilities.

Usage:
    from src.services.transcription import (
        transcribe,
        get_connector,
        supports_diarization,
        TranscriptionRequest,
        TranscriptionResponse,
    )

    # Simple transcription using active connector
    with open('audio.mp3', 'rb') as f:
        request = TranscriptionRequest(
            audio_file=f,
            filename='audio.mp3',
            diarize=True
        )
        response = transcribe(request)
        print(response.text)
        if response.segments:
            for seg in response.segments:
                print(f"[{seg.speaker}]: {seg.text}")
"""

from .base import (
    TranscriptionCapability,
    TranscriptionRequest,
    TranscriptionResponse,
    TranscriptionSegment,
    BaseTranscriptionConnector,
    ConnectorSpecifications,
    DEFAULT_SPECIFICATIONS,
)

from .exceptions import (
    TranscriptionError,
    ConfigurationError,
    ProviderError,
    AudioFormatError,
    ChunkingError,
)

from .registry import (
    ConnectorRegistry,
    get_registry,
    connector_registry,
    transcribe,
    get_connector,
    supports_diarization,
)

from .connectors import AliyunASRConnector

__all__ = [
    # Base types
    'TranscriptionCapability',
    'TranscriptionRequest',
    'TranscriptionResponse',
    'TranscriptionSegment',
    'BaseTranscriptionConnector',
    'ConnectorSpecifications',
    'DEFAULT_SPECIFICATIONS',

    # Exceptions
    'TranscriptionError',
    'ConfigurationError',
    'ProviderError',
    'AudioFormatError',
    'ChunkingError',

    # Registry
    'ConnectorRegistry',
    'get_registry',
    'connector_registry',

    # Convenience functions
    'transcribe',
    'get_connector',
    'supports_diarization',

    # Connectors
    'AliyunASRConnector',
]
