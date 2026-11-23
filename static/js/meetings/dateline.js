(() => {
    const line = document.getElementById('desk-dateline');
    if (!line) return;
    const datePart = line.querySelector('[data-date]');
    const weekPart = line.querySelector('[data-weekday]');
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });
    function stamp() {
        const now = new Date();
        const parts = [now.getFullYear(), ...[now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0'))];
        line.dateTime = parts.join('-');
        datePart.textContent = parts.join(' / ');
        weekPart.textContent = weekday.format(now);
        line.hidden = false;
    }
    stamp();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) stamp(); });
})();
