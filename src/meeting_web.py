"""Serve the same React application to browsers and the Android WebView."""
import json
from pathlib import Path

from flask import current_app, get_flashed_messages, make_response, render_template, request, url_for
from flask_wtf.csrf import generate_csrf

from src.utils.localization import translate


def render_page(page, **props):
    manifest = Path(current_app.static_folder) / 'meeting' / 'manifest.json'
    try:
        entry = json.loads(manifest.read_text(encoding='utf-8'))['src/main.jsx']
    except (OSError, ValueError, KeyError):
        current_app.logger.exception('Meeting frontend not built: run npm --prefix frontend run build')
        response = make_response(render_template('meeting-app.html', unavailable=True), 503)
    else:
        messages = [
            {'tone': 'error' if category in ('danger', 'error') else 'info', 'text': str(message)}
            for category, message in get_flashed_messages(with_categories=True)
            if not (page == 'login' and category == 'info' and message == translate('server.flash.loginRequired'))
        ]
        response = make_response(render_template(
            'meeting-app.html',
            title='登录 · 捷士通智能会议' if page == 'login' else '捷士通智能会议',
            script=url_for('static', filename=f'meeting/{entry["file"]}'),
            styles=[url_for('static', filename=f'meeting/{style}') for style in entry.get('css', [])],
            bootstrap={
                'page': page,
                'csrfToken': generate_csrf(),
                'prefix': request.script_root,
                'homeUrl': url_for('recordings.index'),
                'loginUrl': url_for('auth.login'),
                'logoUrl': url_for('static', filename='img/jst/logo.png'),
                'messages': messages,
                **props,
            },
        ))
    # Private bootstrap data and the bundle reference must never be stale.
    response.headers['Cache-Control'] = 'no-store'
    return response


def form_errors(form):
    return {field: [str(message) for message in messages] for field, messages in form.errors.items()}
