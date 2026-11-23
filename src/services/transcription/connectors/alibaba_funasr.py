"""
Alibaba FunASR connector

Supports Alibaba Cloud FunASR (DAMO Academy speech recognition) service.
Docs: https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api
"""

import json
import logging
import os
import re
import time
from typing import Any, Dict, Optional, Set
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx

from ..base import (
    BaseTranscriptionConnector,
    TranscriptionCapability,
    TranscriptionRequest,
    TranscriptionResponse,
    TranscriptionSegment,
    ConnectorSpecifications,
)
from ..exceptions import TranscriptionError, ConfigurationError, ProviderError
from src.utils.error_body import summarize_error_body
from src.utils.log_filters import loggable_error, loggable_locator

from src.utils.error_text import describe_body, log_failure
logger = logging.getLogger(__name__)

BEIJING_UPLOAD_POLICY = 'https://dashscope.aliyuncs.com/api/v1/uploads'
PENDING_SETUP = 'FunASR is not configured'


class _FunASRPermanentError(TranscriptionError):
    permanent = True


def _is_beijing_oss_url(url: str) -> bool:
    parsed = urlsplit(url)
    return (parsed.scheme == 'https' and re.fullmatch(
        r'(?:[a-z0-9-]+\.)?oss-cn-beijing\.aliyuncs\.com', parsed.netloc
    ) is not None)


def _safe_code(value: Any) -> str:
    code = str(value)
    return code if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', code) else 'unknown'


def _redact_url(url: str) -> str:
    """Remove query credentials before a URL is written to logs."""
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))


class AlibabaFunASRConnector(BaseTranscriptionConnector):
    """Alibaba Cloud FunASR connector."""

    CAPABILITIES: Set[TranscriptionCapability] = {
        TranscriptionCapability.DIARIZATION,
        TranscriptionCapability.TIMESTAMPS,
        TranscriptionCapability.LANGUAGE_DETECTION,
        TranscriptionCapability.SPEAKER_COUNT_CONTROL,
    }
    PROVIDER_NAME = "funasr"

    SPECIFICATIONS = ConnectorSpecifications(
        max_file_size_bytes=None,
        max_duration_seconds=None,
        handles_chunking_internally=True,  # FunASR handles its own chunking
    )

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize Alibaba FunASR connector.

        Args:
            config: Configuration dict with keys:
                - base_url: FunASR API base URL (required)
                - api_key: API key (required)
                - model: Model name (default: "fun-asr")
                - timeout: Transcription timeout in seconds (default: 1800)
                - poll_interval: Seconds between status polls (default: 10)
                - diarize: Enable speaker diarization (default: False)
                - disfluency_removal_enabled: Filter filler words (default: False)
                - timestamp_alignment_enabled: Timestamp alignment (default: False)
                - speaker_count: Speaker count hint (2-100)
                - vocabulary_id: Hot-word ID
                - language_hints: Language hint array (default: ["zh","en"])
                - channel_id: Channel indices (default: None = [0])
                - use_temporary_upload: Use Beijing DashScope private temporary storage
                - allow_unconfigured: Start the app without a key or workspace
        """
        base_url = config.get('base_url', '')
        api_key = config.get('api_key', '')
        model = config.get('model', 'fun-asr')

        self.base_url = base_url.rstrip('/') if base_url else ''
        self.api_key = api_key
        self.model = model
        self._config_timeout = config.get('timeout', 1800)
        self.poll_interval = max(1, int(config.get('poll_interval', 10) or 10))
        self.default_diarize = config.get('diarize', False)
        self.disfluency_removal_enabled = config.get('disfluency_removal_enabled', False)
        self.timestamp_alignment_enabled = config.get('timestamp_alignment_enabled', False)
        self.speaker_count = config.get('speaker_count', None)
        self.vocabulary_id = config.get('vocabulary_id', None)
        self.language_hints = config.get('language_hints', ['zh', 'en'])
        self.channel_id = config.get('channel_id', None)
        self.use_temporary_upload = config.get('use_temporary_upload', False)
        # Resuming is safe in this mode: the staged object survives a worker retry.
        self.SUPPORTS_TASK_RESUME = self.use_temporary_upload

        super().__init__(config)

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    def _validate_config(self) -> None:
        """Validate required configuration."""
        if self.config.get('allow_unconfigured') and not self.is_configured:
            return
        if self.use_temporary_upload and not re.fullmatch(
            r'https://[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com/api/v1', self.base_url
        ):
            raise ConfigurationError('FunASR temporary upload requires a Beijing workspace endpoint.')
        if not self.base_url:
            raise ConfigurationError(
                "base_url is required for Alibaba FunASR connector. "
                "Set ASR_BASE_URL environment variable, "
                "or provide base_url in config."
            )
        if not self.api_key:
            raise ConfigurationError(
                "api_key is required for Alibaba FunASR connector. "
                "Set ASR_API_KEY environment variable, "
                "or provide api_key in config."
            )

    @property
    def timeout(self):
        """Get timeout with env-var override, falling back to config default."""
        env_timeout = os.environ.get('ASR_TIMEOUT')
        if env_timeout:
            try:
                return int(env_timeout)
            except (ValueError, TypeError):
                pass

        return self._config_timeout

    def _temporary_file_url(self, client: httpx.Client, request: TranscriptionRequest) -> str:
        """Stream the processed audio to a short-lived, private OSS object."""
        policy_response = client.get(
            BEIJING_UPLOAD_POLICY,
            headers={'Authorization': f'Bearer {self.api_key}'},
            params={'action': 'getPolicy', 'model': self.model},
            timeout=30.0,
        )
        policy_response.raise_for_status()
        try:
            policy = policy_response.json()['data']
            host = policy['upload_host']
            upload_dir = policy['upload_dir'].strip('/')
            limit_mb = int(policy['max_file_size_mb'])
            access_key, signature, signed_policy = (
                policy['oss_access_key_id'], policy['signature'], policy['policy']
            )
            if (not _is_beijing_oss_url(host) or urlsplit(host).path not in ('', '/')
                    or urlsplit(host).query or urlsplit(host).fragment
                    or not re.fullmatch(r'[a-zA-Z0-9_/-]+', upload_dir)
                    or not all((access_key, signature, signed_policy))
                    or policy['x_oss_object_acl'] != 'private' or limit_mb < 1):
                raise ValueError('unexpected policy')
        except (AttributeError, KeyError, TypeError, ValueError):
            raise ProviderError('FunASR returned an invalid temporary upload policy.',
                                provider=self.PROVIDER_NAME) from None

        try:
            request.audio_file.seek(0, os.SEEK_END)
            size = request.audio_file.tell()
            request.audio_file.seek(0)
        except (AttributeError, OSError, ValueError):
            raise _FunASRPermanentError('FunASR could not read the local recording.') from None
        if not size:
            raise _FunASRPermanentError('FunASR cannot transcribe an empty recording.')
        if size > limit_mb * 1024**2:
            raise _FunASRPermanentError(f'FunASR temporary upload file too large (limit {limit_mb} MB).')

        extension = re.search(r'\.[a-zA-Z0-9]{1,8}$', request.filename)
        filename = uuid4().hex + (extension.group(0).lower() if extension else '.bin')
        object_key = f'{upload_dir}/{filename}'
        # Form fields are scoped to this object. Do not send the API key to OSS.
        uploaded = client.post(host, data={
            'OSSAccessKeyId': access_key,
            'Signature': signature,
            'policy': signed_policy,
            'x-oss-object-acl': 'private',
            'x-oss-forbid-overwrite': policy.get('x_oss_forbid_overwrite', 'true'),
            'key': object_key,
            'success_action_status': '200',
        }, files={'file': (filename, request.audio_file, request.mime_type or 'application/octet-stream')},
            timeout=httpx.Timeout(60.0, write=300.0))
        uploaded.raise_for_status()
        return f'oss://{object_key}'

    def _poll_task_result(self, task_id: str, headers: Dict[str, str], should_cancel=None) -> Dict[str, Any]:
        """
        Poll async task until completion or timeout.

        Args:
            task_id: Task ID from the async submission
            headers: Request headers (Authorization, etc.)

        Returns:
            Task result data on success
        """
        task_url = f"{self.base_url}/tasks/{task_id}"

        max_attempts = max(1, int(self.timeout / self.poll_interval))

        logger.info(f"Polling task result, task_id: {task_id}")

        with httpx.Client() as client:
            for attempt in range(max_attempts):
                if should_cancel and should_cancel():
                    from src.services.job_control import JobCanceled
                    raise JobCanceled()
                try:
                    if attempt % 10 == 0:
                        logger.info(f"Poll attempt {attempt + 1}/{max_attempts}")

                    response = client.get(task_url, headers=headers, timeout=30.0)
                    response.raise_for_status()

                    data = response.json()
                    task_status = data.get('output', {}).get('task_status', 'UNKNOWN')

                    if attempt % 10 == 0:
                        logger.info(f"Task status: {task_status}")

                    if task_status == 'SUCCEEDED':
                        logger.info("Task completed successfully")
                        return data
                    if task_status == 'FAILED':
                        output = data.get('output', {})
                        error_code = output.get('code', 'UNKNOWN_ERROR')
                        error_msg = output.get('message', 'Task failed')

                        if self.use_temporary_upload:
                            raise _FunASRPermanentError(f'FunASR task failed (code: {_safe_code(error_code)}).')

                        logger.debug(f"FunASR full response: {json.dumps(data, indent=2)}")
                        logger.error(f"FunASR task failed: code {error_code if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', str(error_code)) else 'other'}, "
                                     f"message of {len(str(error_msg))} characters")
                        logger.debug(f"FunASR error code: {error_code}, message: {error_msg}")

                        if error_code == 'ASR_RESPONSE_HAVE_NO_WORDS':
                            raise TranscriptionError(
                                "No speech detected in audio file. Please check:\n"
                                "1. Audio contains clear speech\n"
                                "2. Audio volume is adequate\n"
                                "3. Audio format is correct (WAV, 16kHz, mono recommended)\n"
                                "4. Try with a known-good sample audio"
                            )

                        if error_code == 'SUCCESS_WITH_NO_VALID_FRAGMENT':
                            logger.warning("FunASR task succeeded but no valid audio fragments")
                            logger.debug(f"FunASR task succeeded but no valid audio fragments: {error_msg}")
                            return {
                                'output': {
                                    'task_status': 'SUCCEEDED',
                                    'results': [],
                                    'message': error_msg
                                }
                            }

                        raise ProviderError(
                            f"FunASR task failed: {error_msg} (code: {error_code})",
                            provider=self.PROVIDER_NAME,
                            status_code=response.status_code
                        )
                    if task_status in ('PENDING', 'RUNNING'):
                        time.sleep(self.poll_interval)
                    else:
                        logger.warning(f"Unknown task status: {task_status}")
                        time.sleep(self.poll_interval)

                except httpx.HTTPStatusError as e:
                    status = e.response.status_code
                    # 4xx is terminal: a revoked key or bad request will never
                    # succeed on retry, so fail fast instead of burning the
                    # whole timeout window. 429 is transient, so it still
                    # retries (with a doubled backoff).
                    if 400 <= status < 500 and status != 429:
                        logger.error(f"FunASR task query rejected, status {status}")
                        raise ProviderError(
                            f"FunASR task query rejected, status {status}",
                            provider=self.PROVIDER_NAME,
                            status_code=status,
                        ) from e
                    logger.error(f"Task query error: {e}")
                    if attempt < max_attempts - 1:
                        time.sleep(self.poll_interval * (2 if status == 429 else 1))
                    else:
                        raise
                except (httpx.HTTPError, ValueError) as e:
                    logger.error(f"Task query error: {e}")
                    if attempt < max_attempts - 1:
                        time.sleep(self.poll_interval)
                    else:
                        raise

        raise TranscriptionError(f"Task polling timed out, task_id: {task_id}")

    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResponse:
        """
        Transcribe audio using Alibaba Cloud FunASR.

        Args:
            request: Standardized transcription request

        Returns:
            TranscriptionResponse with segments and speaker info
        """
        if not self.is_configured:
            raise _FunASRPermanentError(f'{PENDING_SETUP}: a Beijing workspace and DashScope API key are required.')

        try:
            url = f"{self.base_url}/services/audio/asr/transcription"

            headers = {
                'Authorization': f'Bearer {self.api_key}',
                'Content-Type': 'application/json',
                'X-DashScope-Async': 'enable'
            }

            payload = {
                'model': self.model
            }

            # File URLs injected via extra_options (set up by caller before invoking)
            funasr_file_urls = (request.extra_options or {}).get('funasr_file_urls') or []
            if not self.use_temporary_upload:
                if not funasr_file_urls:
                    logger.error("FunASR requires file URL but none provided")
                    raise TranscriptionError(
                        "FunASR requires file URL. Please upload file to S3 first."
                    )
                payload['input'] = {'file_urls': [funasr_file_urls[0]]}
            elif request.should_cancel and request.should_cancel():
                from src.services.job_control import JobCanceled
                raise JobCanceled()

            # Build parameters dict. Per-request settings win over the
            # env-derived defaults so the UI toggle is honored. The request
            # always carries the resolved value: processing.py falls back to
            # the connector default (default_diarize / ASR_DIARIZE) before
            # building the request, so OR-ing the default here again would
            # override an explicit off toggle from the UI.
            parameters = {}
            diarize = bool(getattr(request, 'diarize', False))
            if diarize:
                parameters['diarization_enabled'] = True
            if self.disfluency_removal_enabled:
                parameters['disfluency_removal_enabled'] = True
            if self.timestamp_alignment_enabled:
                parameters['timestamp_alignment_enabled'] = True

            # Speaker count hint: prefer the request's speaker bounds, falling
            # back to the configured default. FunASR takes a single count, so
            # use max_speakers when given, else min_speakers.
            speaker_count = self.speaker_count
            if getattr(request, 'max_speakers', None) is not None:
                speaker_count = request.max_speakers
            elif getattr(request, 'min_speakers', None) is not None:
                speaker_count = request.min_speakers
            if speaker_count:
                parameters['speaker_count'] = speaker_count
            if self.vocabulary_id:
                parameters['vocabulary_id'] = self.vocabulary_id
            if self.language_hints:
                parameters['language_hints'] = self.language_hints
            if self.channel_id:
                parameters['channel_id'] = self.channel_id
            if parameters or self.use_temporary_upload:
                payload['parameters'] = parameters

            timeout = httpx.Timeout(
                None,
                connect=60.0,
                read=float(self.timeout),
                write=float(self.timeout),
                pool=None
            )

            saved_task = (request.provider_task or {}) if self.use_temporary_upload else {}
            save_task = request.save_provider_task if self.use_temporary_upload else None
            if saved_task and (saved_task.get('workspace') != self.base_url or saved_task.get('model') != self.model):
                raise _FunASRPermanentError('FunASR workspace or model changed since this task was submitted.')
            task_id = saved_task.get('task_id')
            if saved_task and not task_id:
                # The service might already have accepted the request. Do not risk a second charge.
                raise _FunASRPermanentError('FunASR task submission had no clear outcome. Check the cloud console before retrying.')

            with httpx.Client() as client:
                if not task_id:
                    if self.use_temporary_upload:
                        file_url = self._temporary_file_url(client, request)
                        payload['input'] = {'file_urls': [file_url]}
                        headers['X-DashScope-OssResourceResolve'] = 'enable'
                        if request.should_cancel and request.should_cancel():
                            from src.services.job_control import JobCanceled
                            raise JobCanceled()
                    logger.info('Submitting FunASR task (model=%s)', self.model)
                    task_info = {'workspace': self.base_url, 'model': self.model}
                    if save_task:
                        save_task(task_info)
                    response = client.post(url, json=payload, headers=headers, timeout=timeout)
                    if save_task and 400 <= response.status_code < 500:
                        save_task(None)  # Rejected before a task was created.
                    logger.info('FunASR submit status: %s', response.status_code)
                    response.raise_for_status()
                    try:
                        task_id = response.json().get('output', {}).get('task_id')
                    except (AttributeError, ValueError):
                        task_id = None
                    if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
                        raise ProviderError('FunASR did not return a valid task_id',
                                            provider=self.PROVIDER_NAME, status_code=response.status_code)
                    if save_task:
                        save_task({**task_info, 'task_id': task_id})
                elif not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
                    raise _FunASRPermanentError('FunASR saved task ID is invalid.')

                # The resolve and async flags are only needed on submission.
                if self.use_temporary_upload:
                    result_data = self._poll_task_result(
                        task_id, {'Authorization': headers['Authorization']}, request.should_cancel
                    )
                else:
                    result_data = self._poll_task_result(task_id, headers)

                output = result_data.get('output', {})
                results = output.get('results', [])

                if not results:
                    raise TranscriptionError("FunASR returned empty results")

                subtask_status = results[0].get('subtask_status', 'UNKNOWN')
                if subtask_status == 'FAILED':
                    error_code = results[0].get('code', 'UNKNOWN')
                    if self.use_temporary_upload:
                        raise _FunASRPermanentError(f'FunASR subtask failed (code: {_safe_code(error_code)}).')
                    error_msg = results[0].get('message', 'Subtask failed')
                    raise TranscriptionError(f"FunASR subtask failed: {error_msg} (code: {error_code})")

                transcription_url = results[0].get('transcription_url')
                if not transcription_url:
                    raise TranscriptionError("FunASR response missing transcription_url")

                transcription_data = self._download_transcription_result(transcription_url)

                return self._parse_transcription_data(transcription_data)

        except httpx.HTTPStatusError as e:
            logger.error(f"FunASR request failed, status {e.response.status_code}")
            if self.use_temporary_upload:
                try:
                    code = _safe_code(e.response.json().get('code', 'unknown'))
                except (AttributeError, ValueError):
                    code = 'unknown'
                raise ProviderError(f'FunASR request failed, status {e.response.status_code} (code: {code})',
                                    provider=self.PROVIDER_NAME, status_code=e.response.status_code) from None
            error_detail = ""
            try:
                error_response = e.response.json()
                error_detail = json.dumps(error_response)
            except Exception:
                error_detail = e.response.text
            # Summarised, not copied (#593)
            error_detail = summarize_error_body(error_detail, 300)
            error_detail = f": {error_detail}" if error_detail else ""

            raise ProviderError(
                f"FunASR request failed, status {e.response.status_code}{error_detail}",
                provider=self.PROVIDER_NAME,
                status_code=e.response.status_code
            ) from e

        except httpx.TimeoutException as e:
            logger.error(f"FunASR request timed out ({self.timeout}s)")
            raise TranscriptionError(f"FunASR request timed out ({self.timeout}s)") from e

        except TranscriptionError:
            raise
        except Exception as e:
            if self.use_temporary_upload:
                raise TranscriptionError(f'FunASR transcription failed ({type(e).__name__}).') from None
            error_msg = str(e)
            log_failure(logger, logging.ERROR, "FunASR transcription failed", e)
            raise TranscriptionError(f"FunASR transcription failed: {error_msg}") from e

    def _download_transcription_result(self, transcription_url: str) -> Dict[str, Any]:
        """
        Download transcription result from the URL returned by FunASR.

        Args:
            transcription_url: URL to the transcription result JSON

        Returns:
            Transcription result data
        """
        try:
            if self.use_temporary_upload:
                if not _is_beijing_oss_url(transcription_url):
                    raise _FunASRPermanentError('FunASR result did not use the expected Beijing OSS endpoint.')
                logger.info('Downloading FunASR transcription result')
            else:
                logger.info("Downloading transcription result: %s", _redact_url(transcription_url))

            with httpx.Client(timeout=30.0) as client:
                response = client.get(transcription_url)
                response.raise_for_status()

                result_data = response.json()
                logger.info(f"Transcription result downloaded successfully, size: {len(str(result_data))} chars")
                return result_data

        except httpx.HTTPStatusError as e:
            logger.error(f"Transcription result download failed, status: {e.response.status_code}")
            raise ProviderError(
                f"Transcription result download failed, status: {e.response.status_code}",
                provider=self.PROVIDER_NAME,
                status_code=e.response.status_code
            ) from e
        except TranscriptionError:
            raise
        except Exception as e:
            if self.use_temporary_upload:
                raise TranscriptionError(f'FunASR result download failed ({type(e).__name__}).') from None
            log_failure(logger, logging.ERROR, "FunASR transcription result download failed", e)
            raise TranscriptionError(f"Transcription result download failed: {e}") from e

    def _parse_transcription_data(self, data: Dict[str, Any]) -> TranscriptionResponse:
        """
        Parse actual transcription result downloaded from transcription_url.

        The data format (per Aliyun docs):
        {
          "file_url": "...",
          "transcripts": [{
            "channel_id": 0,
            "text": "...",
            "sentences": [{
              "begin_time": 100,
              "end_time": 3820,
              "text": "...",
              "sentence_id": 1,
              "speaker_id": 0,
              "words": [...]
            }]
          }]
        }
        """
        try:
            segments = []
            speakers = set()
            full_text_parts = []

            transcripts = data.get('transcripts', [])
            logger.info(f"Parsing transcription data, transcripts count: {len(transcripts)}")

            for transcript in transcripts:
                sentences = transcript.get('sentences', [])
                for sentence in sentences:
                    text = sentence.get('text', '').strip()
                    if not text:
                        continue

                    speaker_num = sentence.get('speaker_id')
                    speaker_id = f"SPEAKER_{speaker_num}" if speaker_num is not None else None

                    # Aliyun timestamps are in milliseconds, convert to seconds
                    begin_ms = sentence.get('begin_time', 0)
                    end_ms = sentence.get('end_time', 0)
                    try:
                        start_time = float(begin_ms) / 1000.0
                    except (ValueError, TypeError):
                        start_time = 0.0
                    try:
                        end_time = float(end_ms) / 1000.0
                    except (ValueError, TypeError):
                        end_time = 0.0

                    segment = TranscriptionSegment(
                        text=text,
                        speaker=speaker_id,
                        start_time=start_time,
                        end_time=end_time,
                    )
                    segments.append(segment)
                    if speaker_id:
                        speakers.add(speaker_id)
                    full_text_parts.append(f"[{speaker_id}]: {text}" if speaker_id else text)

            full_text = '\n'.join(full_text_parts) if full_text_parts else ''

            logger.info(f"Parse complete: {len(segments)} segments, {len(speakers)} speakers")

            return TranscriptionResponse(
                text=full_text,
                segments=segments,
                speakers=sorted(list(speakers)),
                language=None,
                provider=self.PROVIDER_NAME,
                model=self.model,
                raw_response=data
            )

        except Exception as e:
            log_failure(logger, logging.ERROR, "Failed to parse the FunASR response", e)
            raise TranscriptionError(f"Failed to parse FunASR response: {e}") from e

    @classmethod
    def get_config_schema(cls) -> Dict[str, Any]:
        """Return JSON schema for connector configuration."""
        return {
            "type": "object",
            "required": ["base_url", "api_key"],
            "properties": {
                "base_url": {
                    "type": "string",
                    "description": "FunASR base URL (e.g. https://dashscope.aliyuncs.com/api/v1)"
                },
                "api_key": {
                    "type": "string",
                    "description": "FunASR API key"
                },
                "model": {
                    "type": "string",
                    "default": "fun-asr",
                    "description": "Model name"
                },
                "timeout": {
                    "type": "integer",
                    "default": 1800,
                    "description": "Request timeout in seconds"
                },
                "diarize": {
                    "type": "boolean",
                    "default": False,
                    "description": "Enable speaker diarization"
                },
                "disfluency_removal_enabled": {
                    "type": "boolean",
                    "default": False,
                    "description": "Filter filler words"
                },
                "timestamp_alignment_enabled": {
                    "type": "boolean",
                    "default": False,
                    "description": "Enable timestamp alignment"
                },
                "language_hints": {
                    "type": "array",
                    "items": {"type": "string"},
                    "default": [],
                    "description": "Language hint array"
                }
            }
        }


def prepare_funasr_file_url(recording) -> tuple:
    """Prepare S3 file URL for FunASR transcription.

    Return a short-lived URL suitable for passing to the FunASR API. Existing
    S3 objects are signed directly; local recordings are copied to a staging
    object only when needed. Signed URLs are never persisted.

    Returns:
        tuple: (bool, list) - (success, file URLs)
    """
    from flask import current_app
    from src.config.app_config import S3_INTRANET_ENDPOINT_URL
    from src.services.storage import get_storage_service
    from src.services.storage.locator import parse_locator

    storage = get_storage_service()
    if not storage.s3:
        raise ConfigurationError(
            "FunASR requires S3 storage to be configured. "
            "Please set S3_BUCKET_NAME, S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, "
            "and S3_SECRET_ACCESS_KEY."
        )

    locator_str = storage.maybe_normalize_local_legacy_locator(recording.audio_path)
    if not locator_str:
        locator_str = storage.build_local_locator_from_path(recording.audio_path)

    if not locator_str:
        current_app.logger.warning(f"Audio path not found for recording {recording.id}")
        return False, []

    locator_parsed = parse_locator(locator_str)
    if not locator_parsed:
        return False, []

    if not storage.exists(locator_str):
        current_app.logger.warning(f"Audio not found for recording {recording.id}")
        return False, []

    if locator_parsed.scheme == 's3':
        s3_locator = locator_parsed
    else:
        from os.path import splitext

        from werkzeug.utils import secure_filename

        original_name = recording.original_filename or f"recording_{recording.id}"
        stem, original_ext = splitext(original_name)
        mime_extensions = {
            'audio/mpeg': '.mp3',
            'audio/flac': '.flac',
            'audio/opus': '.opus',
            'audio/wav': '.wav',
        }
        extension = mime_extensions.get(recording.mime_type, original_ext)
        safe_filename = secure_filename(stem + extension)
        object_key = f"funasr/{recording.id}/{safe_filename}"
        s3_locator = parse_locator(storage.s3.build_locator(object_key))

        # Track the staging key so the caller can clean it up after the run.
        # Always re-upload: a replaced audio file must never re-sign a stale
        # staging object left over from a previous run.
        staging_keys = getattr(recording, '_funasr_staging_keys', None)
        if staging_keys is None:
            staging_keys = []
            recording._funasr_staging_keys = staging_keys
        if object_key not in staging_keys:
            staging_keys.append(object_key)

        current_app.logger.info(
            "Uploading recording %s to FunASR staging object %s",
            recording.id,
            loggable_locator(object_key),
        )
        with storage.materialize(locator_str) as materialized:
            storage.s3.upload_local_file(
                materialized.local_path,
                object_key,
                content_type=recording.mime_type or 'application/octet-stream',
            )

    url = storage.s3.presign_get_url(
        s3_locator,
        expires_seconds=86400,
        endpoint_url=S3_INTRANET_ENDPOINT_URL,
    )

    current_app.logger.info(f"FunASR URL ready for recording {recording.id}")
    return True, [url]


def cleanup_funasr_staging(recording) -> None:
    """Best-effort delete of FunASR staging objects created for a recording.

    Deletes the objects uploaded to the ``funasr/{recording.id}/`` prefix so
    the bucket does not grow without bound. Failures are logged and swallowed
    so a cleanup hiccup never fails an otherwise-successful transcription.
    """
    from flask import current_app
    from src.services.storage import get_storage_service
    from src.services.storage.locator import parse_locator

    storage = get_storage_service()
    if not storage.s3:
        return

    staging_keys = getattr(recording, '_funasr_staging_keys', None) or []
    for object_key in staging_keys:
        try:
            s3_locator = parse_locator(storage.s3.build_locator(object_key))
            storage.s3.delete(s3_locator, missing_ok=True)
            current_app.logger.info(f"Cleaned up FunASR staging object {loggable_locator(object_key)}")
        except Exception as exc:  # noqa: BLE001 - best effort only
            current_app.logger.warning(
                f"Failed to clean up FunASR staging object {loggable_locator(object_key)}: "
                f"{loggable_error(exc, object_key)}"
            )
