/**
 * 小助理的工具扩展（pi extension）。
 *
 * - meeting_api：调用应用的本机内部接口 /internal/assistant/*（一次性凭证，只能访问这位用户的数据）。
 *   接口清单和用法写在 skill「meeting-api」里，小助理需要时自己用 read 读。
 * - read 只能读 skills 目录；其他任何工具一律拦截（没有执行命令、写文件、联网的能力）。
 *
 * 运行参数在 MEETING_COMPANION_RUN 指向的 JSON 里（由 Python 写入）。
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type RunConfig = { apiBase: string; token: string; skillsDir: string; maxOutputTokens?: number };

const MAX_RESULT_CHARS = 120_000;

export default function companionTools(pi: ExtensionAPI) {
  const configPath = process.env.MEETING_COMPANION_RUN;
  if (!configPath) throw new Error("MEETING_COMPANION_RUN is not set");
  const config: RunConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const skillsRoot = realpathSync(config.skillsDir);

  if (config.maxOutputTokens) {
    pi.on("before_provider_request", (event) => {
      const payload = event.payload as Record<string, unknown>;
      if (payload && typeof payload === "object" && "max_tokens" in payload) {
        return { ...payload, max_tokens: config.maxOutputTokens };
      }
      return undefined;
    });
  }

  pi.on("tool_call", async (event) => {
    if (event.toolName === "meeting_api") return;
    if (event.toolName !== "read") return { block: true, reason: `小助理不能使用 ${event.toolName}。` };
    const input = event.input as { path?: string };
    let real: string;
    try {
      real = realpathSync(resolve(skillsRoot, input.path ?? ""));
    } catch {
      return { block: true, reason: `找不到 ${input.path}。read 只能读 skill 文件。` };
    }
    const rel = relative(skillsRoot, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { block: true, reason: "read 只能读 skill 文件；会议数据请用 meeting_api 查询。" };
    }
    input.path = real;
  });

  pi.registerTool({
    name: "meeting_api",
    label: "会议数据接口",
    description:
      "调用会议应用的内部接口，查询这位用户的会议、摘要、原文、待办，维护长期记忆和提醒，主动发消息。" +
      "接口清单和用法见 skill「meeting-api」，不确定时先 read 它。",
    promptSnippet: "meeting_api：查询会议、维护长期记忆和提醒（用法见 skill meeting-api）",
    parameters: Type.Object({
      method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PATCH"), Type.Literal("DELETE")]),
      path: Type.String({ description: "以 / 开头的接口路径，例如 /meetings?before=20 或 /memory/m12" }),
      body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "POST / PATCH 的 JSON 请求体" })),
    }),
    async execute(_id, params, signal) {
      const path = params.path.trim();
      // 路径部分只允许字母数字和 - _ /（%2e%2e、反斜杠都会被 URL 解析成 ..）；查询参数里不许有 # 和反斜杠
      const [route, ...rest] = path.split("?");
      const query = rest.join("?");
      if (!/^\/[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*\/?$/.test(route) || /[#\\]/.test(query)) {
        throw new Error("path 必须是以 / 开头的接口路径，例如 /meetings 或 /search?q=回款");
      }
      const url = new URL(`${config.apiBase}/internal/assistant${route}${query ? `?${query}` : ""}`);
      if (!url.pathname.startsWith("/internal/assistant/")) throw new Error("path 不在接口范围内");
      const response = await fetch(url, {
        method: params.method,
        headers: { "Content-Type": "application/json", "X-Assistant-Token": config.token },
        body: params.body && params.method !== "GET" ? JSON.stringify(params.body) : undefined,
        signal,
      });
      let text = await response.text();
      if (text.length > MAX_RESULT_CHARS) {
        text = text.slice(0, MAX_RESULT_CHARS) + "\n…（结果过长，后面的内容没有显示；请用分页参数缩小范围）";
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
      return { content: [{ type: "text" as const, text }], details: { status: response.status, path, method: params.method } };
    },
  });
}
