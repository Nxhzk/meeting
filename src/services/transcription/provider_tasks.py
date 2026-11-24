"""Saved provider tasks for submit-and-poll transcription services.

Alibaba Cloud accepts a job, returns a task ID and is then polled, and it charges
for each job. The task is saved on the running ProcessingJob as
soon as the service accepts it, so a retry of that job (after a polling
timeout, an error or a restart) polls the same task instead of submitting and
paying again. A new job, such as a reprocess the user starts, has no saved task
and always submits. A saved task is used only for the same service and the
same audio bytes.

Alibaba Cloud has no call that cancels or removes a task, so there is nothing to
cancel when a processing job or its recording is deleted: cancel_remote_tasks
and release_remote_task remain only because those paths call them.
"""

import hashlib
import json
import logging
from collections import namedtuple

from src.database import db
from src.models import ProcessingJob

logger = logging.getLogger(__name__)

TRANSCRIPTION_JOB_TYPES = ('transcribe', 'reprocess_transcription')

# saved: the task saved for this service and audio, or None.
# save: stores a task (None forgets it); False when the processing job no
#       longer exists.
# key: a stable name for this processing job and audio (see
#      TranscriptionRequest.task_key).
# report_progress: stores (done, total) on the running job.
ProviderTaskContext = namedtuple('ProviderTaskContext', 'saved save key report_progress')

_NO_CONTEXT = ProviderTaskContext(None, None, None, None)


def _file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as audio:
        for block in iter(lambda: audio.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def audio_task_key(scope, audio_path, part=None):
    """A task key for a transcription that has no saved provider task.

    scope names who asks (a recording, an incognito user, the voice check),
    part the chunk within it, and the digest the audio bytes. A retry of the
    same audio in the same scope therefore gets the same key and attaches to
    the job the service still holds; other audio never does. None when the
    audio cannot be read.
    """
    try:
        digest = _file_sha256(audio_path)[:16]
    except OSError:
        return None
    middle = '' if part is None else f"-{part}"
    return f"{scope}{middle}-{digest}"


def provider_task_context(recording_id, provider, audio_path):
    """Return the ProviderTaskContext of the recording's running job.

    Every field is None when no transcription job is running for the
    recording, as in incognito mode.
    """
    job = (ProcessingJob.query
           .filter(ProcessingJob.recording_id == recording_id,
                   ProcessingJob.status == 'processing',
                   ProcessingJob.job_type.in_(TRANSCRIPTION_JOB_TYPES))
           .order_by(ProcessingJob.id.desc())
           .first())
    if job is None:
        return _NO_CONTEXT
    audio_sha256 = _file_sha256(audio_path)
    try:
        stored = json.loads(job.provider_task) if job.provider_task else None
    except ValueError:
        stored = None
    saved = None
    if (isinstance(stored, dict) and stored.get('provider') == provider
            and stored.get('audio_sha256') == audio_sha256):
        saved = stored.get('task')
    job_id = job.id

    def save(task):
        value = None if task is None else json.dumps(
            {'provider': provider, 'audio_sha256': audio_sha256, 'task': task})
        # Written in its own transaction, at once: the worker may be stopped
        # while the service is still working on the task.
        table = ProcessingJob.__table__
        with db.engine.begin() as connection:
            result = connection.execute(table.update().where(table.c.id == job_id).values(provider_task=value))
        # False: the processing job was deleted while it ran, with its
        # recording or on its own, so nothing was stored.
        return result.rowcount > 0

    from src.services.job_queue import job_progress_writer
    key = f"speakr-{recording_id}-{job_id}-{audio_sha256[:16]}"
    # A service that reports progress reports a share of the work (0..1).
    return ProviderTaskContext(saved, save, key, job_progress_writer(job_id, 'fraction'))


def provider_task_for(recording_id, provider, audio_path):
    """Return (saved task, save function) for the recording's running job.

    Both are None when no transcription job is running for the recording, as
    in incognito mode.
    """
    context = provider_task_context(recording_id, provider, audio_path)
    return context.saved, context.save


def cancel_remote_tasks(jobs):
    """Cancel the provider tasks saved on these processing jobs.

    Aliyun ASR offers no way to cancel a task (it finishes and expires after
    24 hours), so nothing is cancelled. Returns the ids of the processing jobs
    whose remote task was confirmed removed: always none.
    """
    return []


def release_remote_task(job):
    """Remove the provider task saved on a processing job that ends for good.

    Aliyun tasks cannot be removed, so the saved task stays on the job.
    Never raises and does not commit. Returns whether the task was cleared.
    """
    return False
