import { createRoot } from 'react-dom/client';
import { AuthPage } from './auth.jsx';
import { Meetings } from './Meetings.jsx';
import { MeetingRecord } from './MeetingDetail.jsx';
import { Header } from './ui.jsx';
import { initRequests } from './recording/api.js';
import './meeting.css';

const config = JSON.parse(document.getElementById('meeting-bootstrap').textContent);
initRequests(config);

// Stop only the previous worker for this mount. Leave locally staged audio and
// other apps on the same domain alone. The app shell always comes from Flask.
if (navigator.serviceWorker) {
    // Revalidate private views if native/browser Back restores a snapshot.
    // The recorder already prevents leaving during an active capture.
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    const scope = new URL(config.homeUrl, location.origin);
    const oldWorker = new URL('sw.js', scope).pathname;
    navigator.serviceWorker.getRegistration(scope.href).then(registration => {
        if (registration?.scope === scope.href && registration.active && new URL(registration.active.scriptURL).pathname === oldWorker) {
            return registration.unregister();
        }
    }).catch(() => {});
}

const root = createRoot(document.getElementById('root'));
root.render(config.page === 'meetings' ? <Meetings config={config} />
    : config.page === 'share' ? <><Header config={config} /><main className="workspace"><section id="meeting-detail">
        <MeetingRecord meeting={config.meeting} />
    </section></main></> : <AuthPage config={config} />);
