"""Alibaba Cloud Model Studio (DashScope) recording-file ASR: submit a file URL, then poll.

DashScope only takes a URL it can fetch, so the audio is staged in the object
storage bucket, handed over as a presigned link and deleted once recognition
has finished.
"""

import io
import logging
import re
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx

from ..base import (BaseTranscriptionConnector, ConnectorSpecifications,
                    TranscriptionCapability, TranscriptionResponse, TranscriptionSegment)
from ..exceptions import ConfigurationError, ProviderError, TranscriptionError

logger = logging.getLogger(__name__)
DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
FILE_LIMIT = 2 * 1024 * 1024 * 1024
MODELS = ('fun-asr', 'paraformer-v2')
# DashScope keeps task results for 24 hours, so an older saved task is not queried.
TASK_MAX_AGE = 23 * 3600
# Error text of a recording that was saved while the key was missing.
PENDING_SETUP = 'Aliyun ASR is not configured'
TASK_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')


class AliyunSetupPending(TranscriptionError):
    """The key is missing: retrying cannot help, so the job fails at once."""
    permanent = True


class AliyunASRConnector(BaseTranscriptionConnector):
    PROVIDER_NAME = 'aliyun_asr'
    SUPPORTS_TASK_RESUME = True
    CAPABILITIES = {TranscriptionCapability.DIARIZATION, TranscriptionCapability.TIMESTAMPS,
                    TranscriptionCapability.LANGUAGE_DETECTION, TranscriptionCapability.SPEAKER_COUNT_CONTROL}
    SPECIFICATIONS = ConnectorSpecifications(
        max_file_size_bytes=FILE_LIMIT, max_duration_seconds=12 * 3600,
        handles_chunking_internally=True, preserve_original_audio=True)

    def _validate_config(self):
        self.api_key = (self.config.get('api_key') or '').strip()
        # With allow_unconfigured the app starts without a key and still saves
        # recordings (local development, tests); transcription then fails with
        # PENDING_SETUP until ALIYUN_ASR_API_KEY is set.
        self.is_configured = bool(self.api_key)
        if not self.is_configured and not self.config.get('allow_unconfigured'):
            raise ConfigurationError('Aliyun ASR requires ALIYUN_ASR_API_KEY (a Model Studio API key)')
        self.base_url = (self.config.get('base_url') or DEFAULT_BASE_URL).rstrip('/')
        if not self.base_url.startswith('https://'):
            raise ConfigurationError('Aliyun ASR base URL must be https')
        self.model = self.config.get('model') or MODELS[0]
        try:
            self.poll_timeout = float(self.config.get('timeout', 1800))
            self.poll_interval = float(self.config.get('poll_interval', 5))
        except (TypeError, ValueError):
            raise ConfigurationError('Aliyun timeout and poll interval must be positive numbers') from None
        if not (0 < self.poll_interval <= self.poll_timeout <= 10800):
            raise ConfigurationError('Aliyun requires 0 < poll_interval <= timeout <= 10800 seconds')
        self.vocabulary_id = (self.config.get('vocabulary_id') or '').strip()
        self.language_hints = list(self.config.get('language_hints') or ['zh', 'en'])
        self.default_diarize = self.config.get('diarize', True)
        self.staging_prefix = (self.config.get('staging_prefix') or 'aliyun-asr').strip('/')
        if not self.staging_prefix or '..' in self.staging_prefix.split('/'):
            raise ConfigurationError('Aliyun staging prefix must be a nonempty object prefix without ..')

    def _auth(self, **extra):
        return {'Authorization': f'Bearer {self.api_key}', **extra}

    def _parameters(self, request):
        params = {'language_hints': self.language_hints}
        if request.diarize:
            params['diarization_enabled'] = True
            count = request.max_speakers or request.min_speakers
            if count and 2 <= count <= 100:
                params['speaker_count'] = count
        if self.vocabulary_id:
            params['vocabulary_id'] = self.vocabulary_id
        return params

    def _stage(self, path, request):
        from src.services.storage import get_storage_service, parse_locator
        storage = get_storage_service()
        if not storage.s3:
            raise ConfigurationError('Aliyun ASR needs Speakr S3 storage with a publicly reachable endpoint to stage audio')
        key = self.staging_prefix + '/' + uuid4().hex + Path(request.filename).suffix
        locator = parse_locator(storage.s3.build_locator(key))
        try:
            storage.s3.upload_local_file(path, key, content_type=request.mime_type or 'application/octet-stream', acl='private')
            url = storage.s3.presign_get_url(locator, expires_seconds=86400)
            return storage.s3, locator, url
        except Exception:
            self._cleanup(storage.s3, locator)
            raise TranscriptionError('Aliyun ASR staging failed; check S3 configuration and permissions') from None

    @staticmethod
    def _cleanup(storage, locator):
        try:
            storage.delete(locator, missing_ok=True)
            return True
        except Exception:
            logger.warning('Aliyun ASR staging cleanup failed; configure an aliyun-asr/ bucket lifecycle rule')
            return False

    @staticmethod
    def _cleanup_saved(locator_value):
        """Delete a staged object known only from a saved task."""
        if not locator_value:
            return
        from src.services.storage import get_storage_service, parse_locator
        storage = get_storage_service().s3
        if storage:
            AliyunASRConnector._cleanup(storage, parse_locator(locator_value))

    def _http_error(self, action, response):
        code = 'unknown'
        try:
            code = str(response.json().get('code') or 'unknown')
        except (AttributeError, ValueError):
            pass
        code = code if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', code) else 'unknown'
        hint = ''
        if response.status_code in (401, 403) or code in ('InvalidApiKey', 'AccessDenied'):
            hint = ' Check ALIYUN_ASR_API_KEY and that the model is enabled for the account.'
        elif code.startswith(('Arrearage', 'AllocationQuota')):
            hint = ' Check the Model Studio balance or free quota.'
        status = response.status_code
        return ProviderError(f'Aliyun {action}: HTTP {status} ({code}).{hint}',
                             provider=self.PROVIDER_NAME, status_code=status)

    def _poll(self, client, task_id, should_cancel=None):
        deadline = time.monotonic() + self.poll_timeout
        while time.monotonic() < deadline:
            if should_cancel and should_cancel():
                from src.services.job_control import JobCanceled
                raise JobCanceled()
            try:
                response = client.get(f'{self.base_url}/tasks/{task_id}', headers=self._auth())
                if response.status_code != 200:
                    error = self._http_error('task query', response)
                    if response.status_code != 429 and response.status_code < 500:
                        raise error
                else:
                    output = response.json().get('output') or {}
                    status = output.get('task_status')
                    if status == 'SUCCEEDED':
                        return output
                    if status in ('FAILED', 'CANCELED', 'UNKNOWN'):
                        code = str(output.get('code') or 'unknown')
                        code = code if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', code) else 'unknown'
                        raise TranscriptionError(f'Aliyun task {task_id} failed (code: {code})')
            except (httpx.TransportError, ValueError):
                pass  # Polling is safe to retry; submission is not.
            time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
        raise TranscriptionError(f'Aliyun task {task_id}: polling timed out. The remote task may still be running; '
                                 'a retry of this job resumes polling the same task.')

    def transcribe(self, request):
        if not self.is_configured:
            raise AliyunSetupPending(f'{PENDING_SETUP}: set ALIYUN_ASR_API_KEY.')
        params = self._parameters(request)
        saved = request.provider_task or {}
        with httpx.Client(timeout=httpx.Timeout(60, connect=15), follow_redirects=False) as client:
            task_id = saved.get('task_id')
            if saved.get('submitting') and not task_id:
                # A retry of a job whose submission had no clear outcome:
                # DashScope may have accepted it, and submitting again could
                # charge twice. A reprocess starts a new job and submits.
                raise TranscriptionError(
                    'Aliyun ASR: an earlier submission of this recording had no clear outcome and may have been '
                    'accepted. Check the Model Studio console, then reprocess the recording to submit it again.')
            if task_id and (not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id)):
                raise TranscriptionError('Aliyun ASR: the saved task ID is invalid; reprocess the recording.')
            if task_id and time.time() - saved.get('submitted_at', 0) >= TASK_MAX_AGE:
                logger.warning('Aliyun ASR: saved task %s is too old to query; submitting the audio again', task_id)
                self._cleanup_saved(saved.get('staging_locator'))
                task_id = None
            if task_id:
                logger.info('Aliyun ASR: resuming task %s', task_id)
                output = self._poll(client, task_id, request.should_cancel)
                self._cleanup_saved(saved.get('staging_locator'))
            else:
                task_id, storage, locator = self._submit(client, request, params)
                output = self._poll(client, task_id, request.should_cancel)
                if storage:
                    self._cleanup(storage, locator)
            return self._result(client, output, task_id, request.diarize)

    def _submit(self, client, request, params):
        """Stage and send the audio; return the task ID and the staged object."""
        save_task = request.save_provider_task or (lambda task: None)
        try:
            request.audio_file.seek(0)
        except (AttributeError, OSError, io.UnsupportedOperation):
            pass
        from src.services.incognito_temp import dir_for_stream
        with tempfile.TemporaryDirectory(prefix='speakr_aliyun_',
                                         dir=dir_for_stream(request.audio_file)) as directory:
            path = Path(directory) / 'audio'
            size = 0
            with path.open('wb') as output:
                while True:
                    chunk = request.audio_file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > FILE_LIMIT:
                        raise TranscriptionError('Aliyun ASR: audio exceeds the 2 GiB limit')
                    output.write(chunk)
            if not size:
                raise TranscriptionError('Aliyun ASR: empty audio file')
            storage, locator, url = self._stage(str(path), request)
        staging = getattr(locator, 'raw', None)
        # Saved before sending: when no answer arrives, DashScope may still have
        # accepted the task, and a retry of this job must not submit it again.
        save_task({'submitting': True, 'staging_locator': staging})
        payload = {'model': request.model if request.model in MODELS else self.model,
                   'input': {'file_urls': [url]}, 'parameters': params}
        try:
            response = client.post(f'{self.base_url}/services/audio/asr/transcription', json=payload,
                                   headers=self._auth(**{'X-DashScope-Async': 'enable'}))
        except httpx.HTTPError:
            raise TranscriptionError('Aliyun ASR network error during submission. The submission was not retried; '
                                     'DashScope may have accepted it. Check the Model Studio console before '
                                     'reprocessing the recording.') from None
        if response.status_code != 200:
            if 400 <= response.status_code < 500:
                # A definite rejection: nothing was accepted.
                save_task(None)
                self._cleanup(storage, locator)
            raise self._http_error('submit', response)
        try:
            task_id = response.json()['output']['task_id']
        except (KeyError, TypeError, ValueError):
            task_id = None
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
            raise ProviderError('Aliyun submit returned no task ID', provider=self.PROVIDER_NAME)
        save_task({'task_id': task_id, 'submitted_at': time.time(), 'staging_locator': staging})
        logger.info('Aliyun ASR task submitted: %s', task_id)
        return task_id, storage, locator

    def _result(self, client, output, task_id, diarize):
        results = output.get('results') or []
        first = results[0] if results else {}
        # Current responses nest the subtask under 'output'; older ones do not.
        first = first.get('output') if isinstance(first.get('output'), dict) else first
        if first.get('subtask_status') != 'SUCCEEDED' or not first.get('transcription_url'):
            code = str(first.get('code') or 'unknown')
            code = code if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', code) else 'unknown'
            if code == 'SUCCESS_WITH_NO_VALID_FRAGMENT':
                return TranscriptionResponse(text='', segments=None, provider=self.PROVIDER_NAME, model=self.model)
            raise TranscriptionError(f'Aliyun task {task_id}: no result (code: {code})')
        try:
            # The result link is a signed OSS URL: no API key is sent to it.
            response = client.get(first['transcription_url'], timeout=60)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError):
            raise TranscriptionError(f'Aliyun task {task_id}: the result could not be downloaded') from None
        return self._parse_result(data, diarize)

    def _parse_result(self, data, diarize):
        segments = []
        for transcript in data.get('transcripts') or []:
            for sentence in transcript.get('sentences') or []:
                text = (sentence.get('text') or '').strip()
                if not text:
                    continue
                speaker_id = sentence.get('speaker_id')
                speaker = f'SPEAKER_{speaker_id:02d}' if diarize and isinstance(speaker_id, int) and speaker_id >= 0 else None
                begin, end = sentence.get('begin_time'), sentence.get('end_time')
                segments.append(TranscriptionSegment(
                    text=text, speaker=speaker,
                    start_time=begin / 1000 if isinstance(begin, (int, float)) else None,
                    end_time=end / 1000 if isinstance(end, (int, float)) else None))
        duration = (data.get('properties') or {}).get('original_duration_in_milliseconds')
        return TranscriptionResponse(
            text='\n'.join(s.text for s in segments), segments=segments or None,
            speakers=sorted({s.speaker for s in segments if s.speaker}) or None,
            duration=duration / 1000 if isinstance(duration, (int, float)) else None,
            provider=self.PROVIDER_NAME, model=self.model, raw_response=data)

    def list_models(self):
        return [{'id': model} for model in MODELS]

    @classmethod
    def get_config_schema(cls):
        return {'type': 'object', 'required': ['api_key'], 'properties': {
            'api_key': {'type': 'string', 'writeOnly': True},
            'base_url': {'type': 'string', 'default': DEFAULT_BASE_URL},
            'model': {'type': 'string', 'enum': list(MODELS), 'default': MODELS[0]},
            'vocabulary_id': {'type': 'string'}, 'timeout': {'type': 'number', 'default': 1800}}}
