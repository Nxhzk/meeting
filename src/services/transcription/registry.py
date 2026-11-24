"""
Connector registry for transcription.

Alibaba Cloud ASR is the only transcription service this app uses, so the
registry holds that one connector. It is kept as a registry (rather than
importing the connector directly) because the rest of the app asks it for the
active connector, its name and its capabilities.
"""

import os
import logging
from typing import Dict, Any, Optional, Type, List

from .base import BaseTranscriptionConnector, TranscriptionRequest, TranscriptionResponse
from .exceptions import ConfigurationError

logger = logging.getLogger(__name__)

DEFAULT_CONNECTOR = 'aliyun_asr'


class ConnectorRegistry:
    """
    Registry for managing transcription connectors.

    Singleton pattern - use get_registry() to get the shared instance.
    """

    _instance = None
    _connectors: Dict[str, Type[BaseTranscriptionConnector]] = {}
    _active_connector: Optional[BaseTranscriptionConnector] = None
    _connector_name: str = ""
    _initialized: bool = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        from .connectors.aliyun_asr import AliyunASRConnector
        self.register(DEFAULT_CONNECTOR, AliyunASRConnector)
        self._initialized = True

    def register(self, name: str, connector_class: Type[BaseTranscriptionConnector]):
        """Register a connector class under a unique name."""
        self._connectors[name] = connector_class
        logger.debug(f"Registered transcription connector: {name}")

    def get_connector_class(self, name: str) -> Type[BaseTranscriptionConnector]:
        """Get a connector class by name; raises ConfigurationError if unknown."""
        if name not in self._connectors:
            raise ConfigurationError(
                f"Unknown connector: {name}. Available: {list(self._connectors.keys())}"
            )
        return self._connectors[name]

    def create_connector(self, name: str, config: Dict[str, Any]) -> BaseTranscriptionConnector:
        """Create a configured connector instance."""
        return self.get_connector_class(name)(config)

    def list_connectors(self) -> List[Dict[str, Any]]:
        """List registered connectors with their capabilities."""
        return [{
            'name': name,
            'provider_name': cls.PROVIDER_NAME,
            'capabilities': [c.name for c in cls.CAPABILITIES],
            'config_schema': cls.get_config_schema()
        } for name, cls in self._connectors.items()]

    def initialize_from_env(self) -> BaseTranscriptionConnector:
        """
        Initialize the active connector from environment variables.

        TRANSCRIPTION_CONNECTOR may name the connector; it defaults to
        aliyun_asr, the only one there is.
        """
        connector_name = os.environ.get('TRANSCRIPTION_CONNECTOR', '').lower().strip() or DEFAULT_CONNECTOR
        config = self._build_config_from_env(connector_name)

        try:
            self._active_connector = self.create_connector(connector_name, config)
            self._connector_name = connector_name

            logger.info(f"Initialized transcription connector: {connector_name}")
            logger.info(f"Capabilities: {[c.name for c in self._active_connector.get_capabilities()]}")

            return self._active_connector

        except Exception as e:
            logger.error(f"Failed to initialize connector '{connector_name}': {e}")
            raise ConfigurationError(f"Failed to initialize connector '{connector_name}': {e}") from e

    def _build_config_from_env(self, connector_name: str) -> Dict[str, Any]:
        """Build the connector config from environment variables."""
        if connector_name != DEFAULT_CONNECTOR:
            # Fails with the list of available connectors.
            self.get_connector_class(connector_name)
        return {
            'api_key': os.environ.get('ALIYUN_ASR_API_KEY', ''),
            'base_url': os.environ.get('ALIYUN_ASR_BASE_URL', '').split('#')[0].strip(),
            'model': os.environ.get('ALIYUN_ASR_MODEL', 'fun-asr'),
            'timeout': os.environ.get('ALIYUN_ASR_TIMEOUT', '1800'),
            'poll_interval': os.environ.get('ALIYUN_ASR_POLL_INTERVAL', '5'),
            'vocabulary_id': os.environ.get('ALIYUN_ASR_VOCABULARY_ID', ''),
            'language_hints': [h.strip() for h in os.environ.get('ALIYUN_ASR_LANGUAGE_HINTS', 'zh,en').split(',') if h.strip()],
            'staging_prefix': os.environ.get('ALIYUN_ASR_STAGING_PREFIX', 'aliyun-asr'),
            'diarize': os.environ.get('ASR_DIARIZE', 'true').lower() == 'true',
            'allow_unconfigured': os.environ.get('ALIYUN_ASR_ALLOW_UNCONFIGURED', 'false').lower() == 'true',
        }

    def get_active_connector(self) -> BaseTranscriptionConnector:
        """Get the active connector, initializing it from the environment on first use."""
        if not self._active_connector:
            self.initialize_from_env()
        return self._active_connector

    def get_active_connector_name(self) -> str:
        """Get the name of the active connector."""
        if not self._active_connector:
            self.initialize_from_env()
        return self._connector_name

    def reinitialize(self) -> BaseTranscriptionConnector:
        """Force re-initialization, for when environment variables have changed."""
        self._active_connector = None
        self._connector_name = ""
        return self.initialize_from_env()


# Global registry instance
_registry: Optional[ConnectorRegistry] = None


def get_registry() -> ConnectorRegistry:
    """Get the global connector registry."""
    global _registry
    if _registry is None:
        _registry = ConnectorRegistry()
    return _registry


# Convenience aliases
connector_registry = get_registry()


def transcribe(request: TranscriptionRequest) -> TranscriptionResponse:
    """Transcribe audio using the active connector."""
    return get_registry().get_active_connector().transcribe(request)


def get_connector() -> BaseTranscriptionConnector:
    """Get the active transcription connector."""
    return get_registry().get_active_connector()


def supports_diarization() -> bool:
    """Check if the active connector supports diarization."""
    return get_registry().get_active_connector().supports_diarization
