---
name: meeting-api
description: meeting_api 工具的接口清单和用法：查看会议列表、会议摘要、会议原文、跨会议搜索、待办汇总，维护长期记忆，管理提醒和今日简报，主动给用户发消息。调用 meeting_api 前不确定路径或参数时读它。
---

# meeting_api 接口用法

用 `meeting_api(method, path, body)` 调用。路径以 `/` 开头，都只能访问当前这位用户的数据。返回 JSON。出错时返回 `{"error": "原因"}`，按原因修正后再试。

时间：会议时间是 UTC（以 Z 结尾），说给用户听时换成用户当地时间。提醒接口里的时间都是用户当地时间。

## 会议

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/meetings` | 会议列表（新的在前，每页 20 场）。下一页用 `?before=<next_before>` |
| GET | `/meetings/<id>` | 一场会议的最新摘要：`summary`（Markdown）和结构化的 `sections`（决定、待办、待定事项、注意事项） |
| GET | `/meetings/<id>/transcript?offset=0&limit=200` | 会议原文，每页最多 200 句，`total` 是总句数 |
| GET | `/search?q=关键词` | 在标题、摘要、原文里找关键词，返回每场会议命中的片段（最多 30 场） |
| GET | `/todos?days=60` | 最近 N 天（默认 60）各场会议摘要里的待办：任务、负责人、期限、来自哪场会 |

查问题的顺序：先 `/search` 或 `/meetings` 找到会议，再看 `/meetings/<id>` 的摘要；摘要里没有的细节再翻 `/transcript`。原文很长，只读需要的部分。

## 长期记忆（和会议助手共用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/memory` | 最该常记在心的一部分（始终记住的、偏好、最近常用的），附 `total` 总条数；没列全时 `note` 会提示 |
| GET | `/memory?q=王磊 回款` | 按人名、项目、事情等关键词搜（空格隔开几个词），最多 30 条，最相关的在前 |
| POST | `/memory` | 新增：`{"category": "...", "content": "...", "reason": "为什么记"}` |
| PATCH | `/memory/m12` | 修改：`{"content": "...", "category": "...", "reason": "..."}`（只传要改的）；`{"pinned": true}` 设为「始终记住」 |
| DELETE | `/memory/m12` | 删除（软删除，用户能恢复）：可带 `{"reason": "..."}` |

category 只能是：`person`（人物）、`project`（项目）、`recurring_issue`（反复出现的问题）、`preference`（偏好和习惯）。一条最多 500 字，一行。

长期记忆可能有几百条，`GET /memory` 不会全部列出：问到具体的人或事，用 `?q=` 搜；新增前也先搜一下，已有相近的条目就修改它，不要重复新增。只有用户明确说「一定要记住」「永远记得」时才设 `pinned`。记忆多了以后后台会自动整理（合并重复、精简、删掉过时的），你不用自己做大规模清理。

## 提醒（含今日简报）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/reminders` | 全部提醒，附 `now_local`（用户当前时间）和 `timezone` |
| POST | `/reminders` | 新建，见下 |
| PATCH | `/reminders/<id>` | 修改（只传要改的字段；`enabled: false` 关掉） |
| DELETE | `/reminders/<id>` | 删除（今日简报不能删，只能关） |

新建一次性提醒：

```json
{"title": "给王磊回电话", "note": "问杭州回款进度", "repeat": "once", "at": "2026-11-25T15:00"}
```

新建周期提醒（`repeat`：`daily` 每天、`weekdays` 工作日、`weekly` 每周）：

```json
{"title": "看上周待办", "repeat": "weekly", "weekday": 0, "time": "09:00"}
```

`weekday`：0=周一 … 6=周日。`at`、`time` 都是用户当地时间。今日简报是 `is_brief: true` 的那条，改时间用 `{"time": "09:00"}`，关掉用 `{"enabled": false}`。

## 主动发消息

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/messages` | `{"text": "消息内容"}`：发到用户的对话里，用户不在应用里时会推送到手机 |

只在「[系统触发]」的运行里用（提醒到点、今日简报）。平时聊天直接回复即可，不要调这个。
