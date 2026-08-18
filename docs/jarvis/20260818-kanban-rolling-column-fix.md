# 异步任务看板:滚动任务列语义修正

```
status: done
version: 1
created: 2026-08-18
pipeline: subagent-worker
```

## 背景与目标

pi-web(本仓库,Next.js fork)刚上线了异步任务看板(`components/AsyncTasksPanel.tsx`,四列:草稿/待执行/已完成/异常)。当前缺陷:所有带 `.done-<name>` 完成标记的任务都被分进「已完成」列。但**滚动任务**(crontab 里有 `rm -f .done-<name>` 自动清标记行的任务,数据字段 `task.autoClear === true`)的完成标记只代表"当前轮次已跑完",cron 下轮触发前会自动清除标记重跑——滚动任务永不"终结",堆在「已完成」列使看板失真(现实:6 个任务全显示已完成,其中 4 个是每日/每周滚动任务)。

目标:修正列分配与拖拽语义,让滚动任务常驻「待执行」列,并用"上轮完成"徽标表达轮次状态。

## 决策记录

- D1(列语义):列分配函数 `taskColumn()` 改为——
  1. `!task.briefExists` → `failed`
  2. `task.lastRun?.exitCode > 0` → `failed`
  3. **`task.cron && task.autoClear` → `scheduled`(滚动任务,不看 done 标记)**
  4. `task.doneMarker.exists` → `done`(一次性任务的终结态)
  5. `task.cron` → `scheduled`
  6. 其余 → `draft`
- D2(卡片徽标):滚动任务(`autoClear` 且有 cron)卡片上,当前因 `doneMarker.exists` 显示的绿色「已完成」chip 改为显示「上轮完成 <HH:MM 或 MM-DD HH:MM>」(取 `doneMarker.timestamp`,用现有 `formatTime` 即可);一次性任务保持「已完成」chip 不变。
- D3(拖拽语义,`onDropColumn`):滚动任务(`task.autoClear && task.cron`)——
  - 拖到 `done`:先 `window.confirm`(文案走 i18n 新 key,说明"滚动任务移入已完成=移除其调度并停用"),确认后依次调 `save-schedule { spec: null }` 再 `set-done { done: true }`(标记可能已存在,幂等无害)。
  - 拖到 `draft`:`window.confirm`(停用并移回草稿),确认后 `save-schedule { spec: null }` + `set-done { done: false }`(落点:无调度+无标记=草稿)。
  - 拖到 `scheduled`:no-op,toast 提示"滚动任务常驻待执行列"(i18n 新 key)。
  - 一次性任务拖拽语义保持现状不变。
- D4(详情抽屉提示):滚动任务(`autoClear` 且有 cron)在完成标记操作区下方加一行 11px 灰字说明:「滚动任务:完成标记仅表示当前轮次,下轮触发前会被自动清除」(i18n 新 key)。
- D5:「异常」列仍为非放置目标;`draggable()` 函数不变。

## 数据源 / 上下文(自包含)

- 仓库:`/home/xxc/XcRepository/02-Agents/pi-web`,Next.js 16 + React 19,inline-style 惯例(无 CSS 类,全 style 对象),主题用 CSS 变量(`var(--text)` 等)。
- 读数据:`GET /api/async-tasks` 返回 `AsyncStatus`(类型见 `lib/async-status.ts`),任务字段:`name / briefExists / doneMarker{exists,timestamp,summary} / lastRun{startedAt,exitCode,tail} / failedLogs[] / cron{expression,...} / autoClear: boolean / modelOverride`。
- 突变:`POST /api/async-tasks`,body `{ action, name, ... }`,已有 action:`set-done {done:boolean, summary?}`、`save-schedule {spec: ScheduleSpec|null}` 等,组件内经 `mutate(action, payload)` 调用,签名见 `AsyncTasksPanel.tsx` 中 `mutate` useCallback。**后端无需任何改动。**
- i18n:`lib/i18n/messages/zh-CN.ts` 与 `lib/i18n/messages/en.ts` 的 `asyncTasks.*` 段,两文件 key 必须一一对应,占位符用 `{times}` 风格。
- 真实数据参考(验证直觉):6 任务中 `bilibili-topic-radar / idea-sweep / memory-maintenance / self-capture-sweep` 为滚动(autoClear=true 且有 cron),`workmachine-kb-reshare` 为一次性有 cron 已完成,`bilibili-topic5-outline` 为无 cron 已完成。修正后期望分布:待执行 4 / 已完成 2。

## 硬性约束

- **独立任务,与此前对话无关。**
- 改动白名单(只许动这 3 个文件):
  1. `components/AsyncTasksPanel.tsx` —— 只许改:`taskColumn()`、卡片组件 `TaskCard`(chip 部分)、`onDropColumn`、详情抽屉 `DetailDrawer`(完成区提示)、`draggable` 不动。
  2. `lib/i18n/messages/zh-CN.ts`、`lib/i18n/messages/en.ts` —— 只许在 `asyncTasks.*` 段追加新 key(建议:`rollingLastDone` / `rollingRetireConfirm` / `rollingToDraftConfirm` / `rollingStayScheduled` / `rollingNote`),两文件 key 对齐。
- 其余一律不动:禁改 `lib/async-status.ts`、`lib/async-mutations.ts`、`lib/async-schedule.ts`、`app/api/**`、`hooks/**`、其他组件。
- 禁令:禁跑 `next build` / `npm run dev`(构建部署归父会话);禁 `npm install`(不得产生 package-lock.json 变更);禁 commit(归父会话)。
- 只读边界:`~/.pi/async-tasks/` 与 crontab 均为生产数据,只读,禁止任何写删。

## 验收标准

1. `env -u PI_WEB_PASSWORD npm test` 全绿(允许既有 1 个 web-auth 预存失败,与本次无关)。
2. `node_modules/.bin/tsc --noEmit` 零输出;`npm run lint` 零报错。
3. 逻辑自查(用 lib/async-status.ts 的真实字段结构 mock 断言或代码走查):滚动任务带 done 标记 → scheduled 列;一次性 done → done 列;`lastRun.exitCode>0` → failed 列优先。
4. `git status` 无白名单外文件、无锁文件变更。
5. 交付:改动总结 + 每个决策点(D1-D5)的落点说明 + 遗留问题(若有)。

## 结果记录

- 受托方交付:D1-D5 全落地(taskColumn 滚动分支 / rollingLastDone 徽标 / onDropColumn 滚动三分支 / rollingNote 提示 / isRollingTask 谓词三处复用),后端零改动,diff 严格在白名单 3 文件(AsyncTasksPanel +37 行、i18n 各 +5 key)。
- 父会话验收:三件套全绿(env -u PI_WEB_PASSWORD npm test 614 pass/0 fail、tsc/lint 干净);diff 逐决策点走查通过;git status 无意外文件。
- 回流决策:无。遗留:无。
- 注:本次因 herdr server 未跑降级 subagent-worker 且未报备,被皮爷点名;下次默认 herdr/omp。
