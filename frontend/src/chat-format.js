/* 聊天消息的拆分和排版（纯前端、确定性）。

   拆分：小助理的一条回复按段落拆成几个气泡；太长的段落再按句子拆，
   像真人一样分几句发出来。列表整块保留，避免把一条清单拆散。
   排版：只支持聊天里会用到的少量 Markdown（加粗、斜体、行内代码、列表、
   换行），先转义再替换，不会注入任何 HTML。 */

const SENTENCE_END = /([。！？!?]+[”’」』)）*_]*)/;   // 只在句末切；分号、逗号处切会把一个意思拆成两条
const LONG_PARAGRAPH = 140;   // 超过这么长的段落按句子再拆
const CHUNK_TARGET = 90;      // 句子拼成一个气泡时的目标长度
const MIN_CHUNK = 14;         // 太短的气泡并到下一条

function isList(block) {
    return block.split('\n').every(line => /^\s*([-*•]|\d+[.、)])\s+/.test(line) || !line.trim());
}

function sentences(paragraph) {
    const parts = paragraph.split(SENTENCE_END);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
        const text = (parts[i] || '') + (parts[i + 1] || '');
        if (text.trim()) out.push(text.trim());
    }
    return out;
}

/** 一条回复 → 若干气泡的 Markdown 文本。 */
export function splitReply(text) {
    const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const chunks = [];
    for (const block of blocks) {
        if (isList(block) || block.length <= LONG_PARAGRAPH || block.includes('|')) {
            chunks.push(block);
            continue;
        }
        let current = '';
        for (const sentence of sentences(block)) {
            if (current && current.length + sentence.length > CHUNK_TARGET) {
                chunks.push(current);
                current = sentence;
            } else current += sentence;
        }
        if (current) chunks.push(current);
    }
    // 太短的（比如「好的。」）并到下一条，避免一闪而过的小气泡
    const merged = [];
    for (const chunk of chunks) {
        const last = merged.at(-1);
        if (last !== undefined && last.length < MIN_CHUNK && !isList(last) && !isList(chunk)) merged[merged.length - 1] = `${last}${chunk}`;
        else merged.push(chunk);
    }
    return merged;
}

/** 回复正在生成时，哪些气泡已经可以发出去：只看已经写完的段落（后面跟了空行的）。
 *  写到一半的段落还会变（可能变成清单、表格，或长到要按句拆），所以不碰；
 *  最后一个气泡太短的话，回复结束时会并到下一条，也先不发。
 *  这样发出去的气泡一定和回复结束时 splitReply 的结果前几条一模一样。 */
export function completedChunks(text) {
    const clean = String(text || '').replace(/\r/g, '');
    const end = clean.lastIndexOf('\n\n');
    if (end < 0) return [];
    const chunks = splitReply(clean.slice(0, end));
    const last = chunks.at(-1);
    if (last !== undefined && last.length < MIN_CHUNK && !isList(last)) chunks.pop();
    return chunks;
}

/** 打字时长：短句快、长句慢，有上限。 */
export function typingDelay(chunk) {
    return Math.min(1800, Math.max(520, 300 + String(chunk).length * 16));
}

// ------------------------------------------------------------ 迷你 Markdown
function escape(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text) {
    return escape(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/[(（]#(\d+)[)）]/g, '<button type="button" class="meeting-ref" data-meeting="$1">#$1</button>');
}

export function chunkHtml(chunk) {
    const lines = chunk.split('\n');
    if (isList(chunk)) {
        const ordered = /^\s*\d+[.、)]/.test(lines.find(l => l.trim()) || '');
        const items = lines.filter(l => l.trim()).map(l => `<li>${inline(l.replace(/^\s*([-*•]|\d+[.、)])\s+/, ''))}</li>`).join('');
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    }
    return lines.map(line => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        return heading ? `<strong>${inline(heading[1])}</strong>` : inline(line);
    }).join('<br>');
}
