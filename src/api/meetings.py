"""The signed-in meeting workspace for the current account's own recordings."""

import re
from datetime import datetime

import bleach
from flask import Blueprint, current_app, jsonify, request, url_for
from flask_login import current_user, login_required
from sqlalchemy.orm import load_only

from src.database import db
from src.models import Recording, RecordingSession
from src.models.processing_job import ProcessingJob
from src.models.recording_session import RECORDING_SESSION_ENDED
from src.services.transcription.connectors.aliyun_asr import PENDING_SETUP
from src.services import audit
from src.services.recording_deletion import delete_recording_completely, cleanup_orphaned_speakers_quietly
from src.services.llm import TEXT_MODEL_CONFIGURED
from src.utils.error_formatting import is_transcription_error
from src.utils.markdown import md_to_html
from src.utils.transcript_render import parse_segments


meetings_bp = Blueprint('meetings', __name__)
PAGE_SIZE = 16
ACTIVE = {
    'STITCHING': 'saving', 'PENDING': 'waiting', 'QUEUED': 'waiting',
    'PROCESSING': 'transcribing', 'SUMMARIZING': 'summarizing',
}
SHORT_SUMMARY = '[Summary skipped due to short transcription]'
SUMMARY_SENTINELS = ('[Summary skipped', '[Summary generation failed', '[Summary not generated]')
# Minutes are a document, not a source of navigation or remotely loaded media.
DOCUMENT_TAGS = {
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'dl', 'dt', 'dd', 'div', 'span', 'hr', 'sup', 'sub',
}


def home(recording_id=None):
    from src.meeting_web import render_page
    return render_page(
        'meetings', owner=current_user.id, recordingId=recording_id,
        transcriptionPending=bool(current_app.config.get('TRANSCRIPTION_SETUP_PENDING')),
        summaryReady=TEXT_MODEL_CONFIGURED, logoutUrl=url_for('auth.logout'),
        accountUrl=url_for('auth.account'),
    )


def _json(data, status=200):
    response = jsonify(data)
    response.headers['Cache-Control'] = 'no-store'
    return response, status


def _phase(recording):
    if recording.status in ACTIVE:
        return ACTIVE[recording.status]
    if recording.status in ('FAILED', 'CANCELLED', 'CANCELED'):
        if (current_app.config.get('TRANSCRIPTION_SETUP_PENDING')
                and (recording.error_message or '').startswith(PENDING_SETUP)):
            return 'asr_pending'
        return 'failed'
    summary = (recording.summary or '').strip()
    if summary == SHORT_SUMMARY:
        return 'too_short'
    return 'ready' if summary and not summary.startswith(SUMMARY_SENTINELS) else 'no_minutes'


def _iso(value):
    # Speakr's naive datetimes are UTC, not the browser's local time.
    return value.isoformat(timespec='seconds') + 'Z' if value else None


def _deletion_identity(recording):
    # SQLite can reuse a deleted row's integer id. A confirmation opened on
    # the old row must not be able to delete its replacement.
    return recording.created_at.isoformat(timespec='microseconds') if recording.created_at else None


def _may_delete():
    from src.api import recordings
    return bool(current_user.is_admin or recordings.USERS_CAN_DELETE)


def _card(recording):
    title = (recording.title or '').strip()
    if title in ('', 'Recording', 'Untitled') or re.match(r'^(?:Recovered recording |Recording - |Recording \d{4}-\d{2}-\d{2})', title):
        title = '会议记录'
    return {
        'id': recording.id,
        'title': title,
        'date': _iso(recording.meeting_date or recording.created_at),
        'deletion_identity': _deletion_identity(recording),
        'phase': _phase(recording),
    }


def _speaker(label, anonymous):
    label = str(label or '').strip()
    if re.fullmatch(r'speaker[_ -]?\d+', label, re.IGNORECASE):
        # ASR identifiers are not necessarily consecutive. Number speakers
        # in first-appearance order rather than showing gaps (1, 13, ...).
        key = re.sub('[^0-9]', '', label).lstrip('0') or '0'
        return f'发言人 {anonymous.setdefault(key, len(anonymous) + 1)}'
    return '' if label.lower() in ('unknown', 'speaker', '未知', 'unknown speaker') else label[:128]


def document_html(text):
    return bleach.clean(md_to_html(text), tags=DOCUMENT_TAGS, attributes={}, strip=True) if text else ''


def transcript_rows(transcription):
    text = (transcription or '').strip()
    if not text or is_transcription_error(text):
        return []
    segments = parse_segments(text)
    if segments is None:
        return [{'text': text}]
    rows = []
    anonymous = {}
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        content = segment.get('sentence') or segment.get('text')
        if not isinstance(content, str) or not content.strip():
            continue
        start = segment.get('start_time')
        rows.append({
            'speaker': _speaker(segment.get('speaker'), anonymous),
            'start': int(start) if isinstance(start, (int, float)) and 0 <= start < 7 * 86400 else None,
            'text': content.strip(),
        })
    return rows


@meetings_bp.get('/api/meetings')
@login_required
def list_meetings():
    before = request.args.get('before', type=int)
    rows = Recording.query.filter(
        Recording.user_id == current_user.id, Recording.is_archived.is_not(True),
    ).options(load_only(
        Recording.id, Recording.title, Recording.status, Recording.summary,
        Recording.created_at, Recording.meeting_date, Recording.error_message,
    ))
    if before is not None:
        rows = rows.filter(Recording.id < before)
    rows = rows.order_by(Recording.id.desc()).limit(PAGE_SIZE + 1).all()
    return _json({
        'live_meetings': [
            {'id': s.id, 'started_at': _iso(s.created_at), 'last_audio_at': _iso(s.last_seen_at) if s.chunk_count else None,
             'phase': ('ending' if s.meeting_stop_requested_at or s.meeting_deadline <= datetime.utcnow() else
                       'starting' if not s.chunk_count else
                       'paused' if (datetime.utcnow()-s.last_seen_at).total_seconds() > 30 else 'receiving'),
             **s.meeting_timing()}
            for s in RecordingSession.query.filter_by(user_id=current_user.id, kind='meeting', status='recording')
            .order_by(RecordingSession.created_at.desc()).all()
        ],
        'meetings': [_card(row) for row in rows[:PAGE_SIZE]],
        'may_delete': _may_delete(),
        'next_before': rows[PAGE_SIZE - 1].id if len(rows) > PAGE_SIZE else None,
    })


@meetings_bp.get('/api/meetings/<int:recording_id>')
@login_required
@audit.access('recording.viewed', dedup=audit.DEDUP_VIEW)
def meeting_detail(recording_id):
    recording = Recording.query.filter_by(id=recording_id, user_id=current_user.id).first()
    if recording is None:
        return _json({'error': '找不到这条会议记录。'}, 404)
    result = _card(recording)
    phase = result['phase']
    # Never expose storage locators; the authenticated audio route handles
    # storage, MIME types and byte ranges for seeking.
    result['audio_url'] = (
        url_for('recordings.get_audio', recording_id=recording.id)
        if phase != 'saving' and recording.audio_path and not recording.audio_deleted_at else None
    )
    if phase in ACTIVE.values():
        return _json(result)

    transcript = transcript_rows(recording.transcription)
    retry = None
    if TEXT_MODEL_CONFIGURED and transcript and phase in ('failed', 'no_minutes'):
        retry = 'summary'
    elif (phase == 'failed' and not transcript and not current_app.config.get('TRANSCRIPTION_SETUP_PENDING')
          and recording.audio_path and not recording.audio_deleted_at):
        retry = 'transcription'
    result.update(
        summary_html=document_html(recording.summary) if phase == 'ready' else '',
        transcript=transcript,
        retry=retry,
        duration=recording.get_audio_duration(allow_probe_fallback=False),
    )
    return _json(result)


@meetings_bp.delete('/api/meetings/<int:recording_id>')
@login_required
@audit.emits('recording.deleted')
def delete_meeting(recording_id):
    recording = Recording.query.filter_by(id=recording_id, user_id=current_user.id).first()
    if recording is None:
        return _json({'error': '这条会议记录已不存在。'}, 404)
    if not _may_delete():
        return _json({'error': '此账号没有删除权限。'}, 403)
    payload = request.get_json(silent=True)
    identity = payload.get('identity') if isinstance(payload, dict) else None
    if not identity or _deletion_identity(recording) != identity:
        return _json({'error': '这条记录已经变化，请返回列表确认。'}, 409)

    if (recording.status in ACTIVE or ProcessingJob.query.filter(
        ProcessingJob.recording_id == recording_id,
        ProcessingJob.status.in_(('queued', 'processing')),
    ).first() is not None or RecordingSession.query.filter(
        RecordingSession.finalized_recording_id == recording_id,
        RecordingSession.status.notin_(RECORDING_SESSION_ENDED),
    ).first() is not None):
        return _json({'error': '这条记录正在保存或整理，请稍后再删除。'}, 409)

    try:
        delete_recording_completely(recording, strict_media=True)
        cleanup_orphaned_speakers_quietly()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('Meeting deletion failed for recording %s', recording_id)
        return _json({'error': '这条记录未能删除，请稍后重试。'}, 500)
    return _json({'success': True})
