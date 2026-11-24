// Keep only unacknowledged audio across refreshes. The server is the main
// store; each chunk is removed here once Speakr confirms it has been saved.
let connection;
const writes = new Map();

function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
        const pending = indexedDB.open('SpeakrMeetingDrafts', 1);
        pending.onupgradeneeded = () => pending.result.createObjectStore('chunks');
        pending.onsuccess = () => resolve(pending.result);
        pending.onerror = pending.onblocked = () => reject(pending.error || new Error('Local storage unavailable'));
    });
    // Do not block the live upload if storage is disabled or at quota.
    return connection;
}

async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', mode);
        const pending = action(tx.objectStore('chunks'));
        tx.oncomplete = () => resolve(pending.result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('Local storage unavailable'));
    });
}

const range = (session) => IDBKeyRange.bound([session, 0], [session, Number.MAX_SAFE_INTEGER]);

export function stageChunk(session, chunk) {
    const adding = transaction('readwrite', (store) => store.put(chunk, [session, chunk.index])).catch(() => {});
    writes.set(chunk, adding);
}

export function dropChunk(session, chunk) {
    // Even if the network acknowledgement beats a slow local write, the
    // deletion is queued behind that write.
    const adding = writes.get(chunk) || Promise.resolve();
    writes.delete(chunk);
    adding.then(() => {
        return transaction('readwrite', (store) => store.delete([session, chunk.index]));
    }).catch(() => {});
}

export function readChunks(session) {
    return transaction('readonly', (store) => store.getAll(range(session))).catch(() => []);
}

export function clearChunks(session) {
    return transaction('readwrite', (store) => store.delete(range(session))).catch(() => {});
}
