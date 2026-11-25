/**
 * 会议助手的工具扩展（pi extension）。
 *
 * - 只开放 pi 自带的 read / ls（grep 依赖外部 ripgrep，不开放），且路径被锁在本场会议的资料目录里；
 *   其他任何工具调用一律拦截。
 * - 记录会议原文各段是否读完，没读完不许提交摘要。
 * - save_summary 与 4 个记忆工具只做校验并把结果放进 details，
 *   由 Python 从事件流里收集，生成成功后在一个事务里写库。
 *
 * 运行参数在 MEETING_ASSISTANT_RUN 指向的 JSON 里（由 Python 写入，
 * 位于资料目录之外，会议助手读不到）。
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type Part = { path: string; lines: number };
type MemoryItem = { id: string; category: string; content: string; pinned?: boolean };
type RunConfig = {
  meetingDir: string;
  parts: Part[];
  memory: MemoryItem[];
  categories: Record<string, string>;
  limits: { entryChars: number; maxEntries: number; textChars: number; listItems: number };
  maxOutputTokens?: number;
};

const BUILTIN_READ_TOOLS = new Set(["read", "ls"]);
const OWN_TOOLS = new Set(["save_summary", "list_memory", "search_memory", "add_memory", "update_memory", "delete_memory"]);
const COVERAGE_ENTRY = "meeting-read-coverage";

function text(message: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: message }], details };
}

function fail(message: string): never {
  // pi 把工具抛出的异常作为错误结果返回给模型，模型据此修正后重试。
  throw new Error(message);
}

export default function meetingTools(pi: ExtensionAPI) {
  const configPath = process.env.MEETING_ASSISTANT_RUN;
  if (!configPath) throw new Error("MEETING_ASSISTANT_RUN is not set");
  const config: RunConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const meetingRoot = realpathSync(config.meetingDir);
  const partLines = new Map(config.parts.map((part) => [realpathSync(resolve(meetingRoot, part.path)), part.lines]));
  const covered = new Set<string>();
  const L = config.limits;

  // ---- 记忆：快照 + 本次的改动，只在内存里 ----
  const memory = new Map<string, MemoryItem>(config.memory.map((item) => [item.id, { ...item }]));
  let nextNew = 1;
  const line = (item: MemoryItem) =>
    `${item.id} [${config.categories[item.category] ?? item.category}]${item.pinned ? "（始终记住）" : ""} ${item.content}`;

  // 和 Python 端（services/meeting_assistant/memory.py）同样的匹配：字的二元组，两个字的人名也能找到
  function grams(value: string): Set<string> {
    const out = new Set<string>();
    for (const token of value.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []) {
      if (/^[a-z0-9]+$/.test(token)) {
        if (token.length >= 2) out.add(token);
        continue;
      }
      const chars = [...token];
      if (chars.length === 1) out.add(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    }
    return out;
  }

  function checkCategory(category: string) {
    if (!(category in config.categories)) {
      fail(`分类必须是 ${Object.keys(config.categories).join(" / ")} 之一。`);
    }
  }
  function checkContent(content: string) {
    const value = (content ?? "").trim();
    if (!value) fail("记忆内容不能为空。");
    if (value.length > L.entryChars) fail(`一条记忆最多 ${L.entryChars} 字，请精简或拆成更具体的条目。`);
    if (/[\r\n]/.test(value)) fail("一条记忆只写一行，不要换行。");
    return value;
  }

  // ---- 路径限制 ----
  function insideMeeting(rawPath: string | undefined): string {
    const candidate = resolve(meetingRoot, rawPath && rawPath.trim() ? rawPath : ".");
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      fail(`找不到 ${rawPath}。只能访问会议资料目录里的文件，先用 ls 查看。`);
    }
    const rel = relative(meetingRoot, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      fail("只能访问本场会议的资料目录。");
    }
    return real;
  }

  // pi 默认把单次输出限制在 32000 token；思考档位开到最高时，长会议的
  // 思考加上摘要会超过这个数，按配置放宽。
  if (config.maxOutputTokens) {
    pi.on("before_provider_request", (event) => {
      const payload = event.payload as Record<string, unknown>;
      if (payload && typeof payload === "object" && "max_tokens" in payload) {
        return { ...payload, max_tokens: config.maxOutputTokens };
      }
      return undefined;
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    // 重新生成时，上一次在本会话里读过的段落依然算读过。
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === COVERAGE_ENTRY) {
        // 记录的是相对资料目录的路径：每次运行的临时目录都不同
        for (const saved of (entry.data as { paths?: string[] })?.paths ?? []) {
          // 旧版本记的是当时临时目录下的绝对路径，取 meeting/ 之后的部分
          const rel = isAbsolute(saved) && saved.includes(`${sep}meeting${sep}`) ? saved.split(`${sep}meeting${sep}`).pop()! : saved;
          const path = resolve(meetingRoot, rel);
          if (partLines.has(path)) covered.add(path);
        }
      }
    }
  });

  pi.on("tool_call", async (event) => {
    if (OWN_TOOLS.has(event.toolName)) return;
    if (!BUILTIN_READ_TOOLS.has(event.toolName)) {
      return { block: true, reason: `会议助手不能使用 ${event.toolName}。` };
    }
    try {
      const input = event.input as { path?: string };
      input.path = insideMeeting(input.path);
    } catch (error) {
      return { block: true, reason: (error as Error).message };
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;
    const input = event.input as { path?: string; offset?: number; limit?: number };
    const path = input.path ? resolve(meetingRoot, input.path) : "";
    const lines = partLines.get(path);
    if (lines === undefined) return;
    const start = input.offset ?? 1;
    const end = input.limit === undefined ? Infinity : start + input.limit - 1;
    if (start <= 1 && end >= lines && !covered.has(path)) {
      covered.add(path);
      pi.appendEntry(COVERAGE_ENTRY, { paths: [...covered].map((p) => relative(meetingRoot, p)) });
    }
  });

  // ---- 提交摘要 ----
  // 字段只定义「有哪几节」，不设条数和字数上限：怎么写、写多长以纪要规范（meeting-minutes skill）为准。
  const text_ = (description: string) => Type.String({ description });
  const list = (description: string) => Type.Array(Type.String(), { description });

  pi.registerTool({
    name: "save_summary",
    label: "提交会议摘要",
    description:
      "提交本场会议的会议摘要（必须调用；重新生成时也要提交完整内容）。各节的写法以纪要规范 meeting-minutes 为准。",
    promptSnippet: "save_summary：按纪要规范提交结构化的会议摘要（必须调用）",
    parameters: Type.Object({
      summary: text_("一句话总结"),
      decisions: Type.Array(
        Type.Object({ decision: text_("决定"), reason: Type.Optional(text_("理由")) }),
        { description: "决定；没有就给空数组" },
      ),
      action_items: Type.Array(
        Type.Object({
          task: text_("要做的事"),
          owner: text_("负责人；原文没有明确时写「未明确」"),
          due: Type.Optional(text_("期限")),
          done_when: Type.Optional(text_("完成标准")),
        }),
        { description: "待办；没有就给空数组" },
      ),
      discussion: Type.Array(
        Type.Object({ topic: text_("议题"), points: list("要点") }),
        { description: "讨论要点，按议题归纳" },
      ),
      open_questions: list("待定事项；没有就给空数组"),
      cautions: Type.Object(
        {
          meeting_process: list("会议本身"),
          business_risks: list("业务风险"),
          recurring: list("再次出现的问题"),
        },
        { description: "本次注意事项，三类分开；没有就给空数组" },
      ),
      other: Type.Optional(list("其他")),
    }),
    async execute(_id, params) {
      const missing = [...partLines.keys()].filter((path) => !covered.has(path));
      if (missing.length) {
        const names = missing.map((path) => relative(meetingRoot, path)).join("、");
        fail(`会议原文还没读完：${names}。请用 read 完整读完这些段落后再提交。`);
      }
      if (!params.summary.trim()) fail("一句话总结不能为空。");
      return text("会议摘要已收到。", { summary: params });
    },
  });

  // ---- 长期记忆 ----
  pi.registerTool({
    name: "list_memory",
    label: "查看长期记忆",
    description: "列出这位用户的长期记忆（含本次已做的改动）。可按分类筛选。",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "只看这个分类" })),
    }),
    async execute(_id, params) {
      const rows = [...memory.values()].filter((item) => !params.category || item.category === params.category);
      if (!rows.length) return text("（没有记忆条目）");
      const shown = rows.slice(-L.listItems);
      const more = rows.length > shown.length ? `\n（共 ${rows.length} 条，只列出最近的 ${shown.length} 条；找具体的人或事用 search_memory。）` : "";
      return text(shown.map(line).join("\n") + more);
    },
  });

  pi.registerTool({
    name: "search_memory",
    label: "搜索长期记忆",
    description: "按人名、项目名、问题等关键词搜索长期记忆（包括用户消息里没有列出的条目）。可以一次给几个关键词，用空格隔开。",
    parameters: Type.Object({
      query: Type.String({ description: "关键词，例如「王磊 杭州 回款」", maxLength: 200 }),
    }),
    async execute(_id, params) {
      const wanted = grams(params.query);
      if (!wanted.size) fail("请给出关键词。");
      const hits = [...memory.values()]
        .map((item) => {
          const own = grams(item.content);
          let overlap = 0;
          for (const g of own) if (wanted.has(g)) overlap++;
          return { item, value: own.size ? overlap / wanted.size + (0.2 * overlap) / own.size : 0, overlap };
        })
        .filter((hit) => hit.overlap > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 30);
      if (!hits.length) return text(`没有找到和「${params.query}」相关的记忆。`);
      return text(hits.map((hit) => line(hit.item)).join("\n"));
    },
  });

  pi.registerTool({
    name: "add_memory",
    label: "新增长期记忆",
    description:
      "新增一条长期记忆。只记以后的会议真正用得上的信息：人物与职责、项目与进展、反复出现的问题、用户偏好。不要记一次性的细节，不要和已有条目重复（重复就用 update_memory 合并）。",
    parameters: Type.Object({
      category: Type.String({ description: Object.entries(config.categories).map(([k, v]) => `${k}=${v}`).join("，") }),
      content: Type.String({ description: "一行，独立可读，写清主语" }),
      reason: Type.String({ description: "为什么值得长期记住", maxLength: 300 }),
    }),
    async execute(_id, params) {
      checkCategory(params.category);
      const content = checkContent(params.content);
      if (memory.size >= L.maxEntries) fail(`长期记忆已达安全上限 ${L.maxEntries} 条，请先合并（update_memory）或删除过时的条目。`);
      const id = `n${nextNew++}`;
      memory.set(id, { id, category: params.category, content });
      return text(`已记下 ${id}。`, { memory: { op: "add", id, category: params.category, content, reason: params.reason } });
    },
  });

  pi.registerTool({
    name: "update_memory",
    label: "修改长期记忆",
    description: "修改或合并一条已有的长期记忆（内容过时、需要补充、和别的条目重复时使用）。",
    parameters: Type.Object({
      id: Type.String({ description: "条目编号，如 m12 或 n1" }),
      content: Type.String({ description: "修改后的完整内容，一行" }),
      category: Type.Optional(Type.String({ description: "需要改分类时填写" })),
      reason: Type.String({ description: "为什么修改", maxLength: 300 }),
    }),
    async execute(_id, params) {
      const item = memory.get(params.id);
      if (!item) fail(`没有编号为 ${params.id} 的记忆，先用 search_memory 查到编号。`);
      const category = params.category ?? item.category;
      checkCategory(category);
      const content = checkContent(params.content);
      memory.set(params.id, { id: params.id, category, content });
      return text(`已修改 ${params.id}。`, { memory: { op: "update", id: params.id, category, content, reason: params.reason } });
    },
  });

  pi.registerTool({
    name: "delete_memory",
    label: "删除长期记忆",
    description: "删除一条错误、过时或已被合并的长期记忆。",
    parameters: Type.Object({
      id: Type.String({ description: "条目编号" }),
      reason: Type.String({ description: "为什么删除", maxLength: 300 }),
    }),
    async execute(_id, params) {
      if (!memory.has(params.id)) fail(`没有编号为 ${params.id} 的记忆。`);
      memory.delete(params.id);
      return text(`已删除 ${params.id}。`, { memory: { op: "delete", id: params.id, reason: params.reason } });
    },
  });
}
