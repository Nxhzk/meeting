import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './recording/api.js';
import { processing } from './MeetingDetail.jsx';

const empty = { cards: [], live: [], more: null, canDelete: false, loaded: false, error: null };

export function useMeetings(enabled, syncLive, fastPoll) {
    const [data, setData] = useState(empty);
    const [loading, setLoading] = useState(false);
    const latest = useRef(empty);
    const inflight = useRef(null);
    const olderLoaded = useRef(false);
    const update = useCallback(next => {
        latest.current = next;
        setData(next);
    }, []);

    const load = useCallback((older = false) => {
        if (inflight.current) return inflight.current;
        if (older && latest.current.more == null) return Promise.resolve(latest.current);
        setLoading(true);
        inflight.current = (async () => {
            try {
                const result = await request(`/api/meetings${older ? `?before=${latest.current.more}` : ''}`);
                const previous = latest.current;
                const live = result.live_meetings || [];
                syncLive(live);
                const retain = olderLoaded.current && !older && result.meetings.length
                    ? previous.cards.filter(card => card.id < result.meetings.at(-1).id) : [];
                const rows = older ? [...previous.cards, ...result.meetings] : [...result.meetings, ...retain];
                const more = older || !olderLoaded.current ? result.next_before : previous.more;
                if (older) olderLoaded.current = true;
                update({ cards: [...new Map(rows.map(card => [card.id, card])).values()], live, more,
                    canDelete: result.may_delete === true, loaded: true, error: null });
            } catch (error) {
                if (error.status === 401) {
                    olderLoaded.current = false;
                    update({ ...empty, loaded: true, error: 'login' });
                } else {
                    const previous = latest.current;
                    update({ ...previous, error: !previous.loaded || older ? 'network' : previous.error });
                }
            } finally {
                inflight.current = null;
                setLoading(false);
            }
            return latest.current;
        })();
        return inflight.current;
    }, [syncLive, update]);

    const remove = useCallback(async card => {
        await inflight.current;
        update({ ...latest.current, cards: latest.current.cards.filter(row => row.id !== card.id || row.deletion_identity !== card.deletion_identity) });
    }, [update]);

    useEffect(() => {
        if (!enabled) return;
        const returned = () => { if (!document.hidden) load(); };
        document.addEventListener('visibilitychange', returned);
        window.addEventListener('online', returned);
        returned();
        return () => {
            document.removeEventListener('visibilitychange', returned);
            window.removeEventListener('online', returned);
        };
    }, [enabled, load]);

    useEffect(() => {
        if (!enabled || loading || data.error === 'login') return;
        const timer = setTimeout(() => {
            if (!document.hidden) load();
        }, data.live.length || fastPoll ? 3000 : data.cards.some(card => processing.has(card.phase)) ? 4000 : 8000);
        return () => clearTimeout(timer);
    }, [data, enabled, fastPoll, load, loading]);

    return { data, loading, load, remove };
}
