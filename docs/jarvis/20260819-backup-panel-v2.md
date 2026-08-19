# 备份面板 V2:连续性热力 + 趋势图 + 操作闭环 + 远端副本

```
status: done
version: 1
created: 2026-08-19
pipeline: herdr-agent
```

## 背景与目标

pi-web(本仓库)现有备份面板(V1,`components/BackupsPanel.tsx`)是只读小模态:RPO 卡 + 平铺归档列表 + 脚本注释摘要。缺陷:① 平铺列表无趋势(备份大小 3.4M→12M 逐日增长、08-15 曾有 120M 异常包,肉眼难辨);② RPO 只看最新一份,看不到"哪天漏了"(连续性才是备份健康的核心);③ 无操作闭环(大改动后想立即备份只能 ssh);④ 远端副本一直显示 "V2 接入" 占位——实际 `~/kb` 整目录在 syncthing 同步范围内,REST API 现成。

目标:升级为与异步任务看板同级的全屏面板——健康总览(热力)+ 趋势 + 操作(立即备份/校验/下载)+ 远端副本状态。

## 决策记录

- D1(信息架构):`BackupsPanel` 改为全屏模态(参照 `AsyncTasksPanel.tsx` 的容器样式:inset 0、maxWidth 1400、内滚动)。内容自上而下:① 健康总览卡(RPO 状态行 + 近 14 天连续性热力条)② 备份大小趋势卡(纯 CSS 柱状图,无第三方库)③ 归档列表(现存为主,`index.log` 全史合并,已轮转条目灰显标"已清理")④ 远端副本卡(syncthing kb 文件夹各设备完成度)⑤ 脚本摘要(默认折叠,展开 pre)。
- D2(连续性热力):最近 14 天,每天一格(约 18px 高条,横向 14 格);有备份=绿色(多份取最新时间)、缺=红 #ef4444、未来/今天未到点=灰;hover title="日期 · 份数 · 最新时间"。数据源:archives ∪ index.log(按本地时区日聚合)。
- D3(趋势柱状图):取全史最近 30 份(时间升序),每柱高度按 size 线性归一(最大值封顶),柱宽均分;hover title="文件名 · 大小 · 时间";单份 > 50MB 标红(异常信号,历史判例 120M);下方不用坐标轴,只标首尾时间。
- D4(操作闭环,三个动作):
  - **立即备份**:`POST /api/backups {action:"run-backup"}` → 服务端 spawn `~/bin/pi-backup.sh`(detached、stdout 追加 `~/.pi/backup.log`,与 cron 行为一致);重复触发防护:服务端 `pgrep -f pi-backup.sh` 已在跑则返回 `{error:"already running"}`。前端触发后按钮置"运行中…"并 5s 轮询 GET,发现最新归档时间戳 > 触发时刻或进程消失即刷新并 toast。
  - **校验最新**:`POST {action:"verify-latest"}` → 服务端 `sha256sum -c` 校验最新归档的 .sha256(12MB 秒级,同步返回结果);GET 数据增加 `latestVerify: {at, ok, error} | null`(内存缓存即可,重启失效可接受)。
  - **下载**:`GET /api/backups/download?file=<name>` → 文件名必须完整匹配归档正则(复用 lib/backup-status.ts 的 ARCHIVE_PATTERN 模式,严格 path.join 定界,禁止 `..`),流式返回,`Content-Disposition: attachment`。列表每行加下载小按钮。
- D5(远端副本):GET 扩展 `remote` 字段。服务端实现(新文件 `lib/backup-remote.ts`):读 `~/.local/state/syncthing/config.xml` 拿 `<gui>` 的 apikey 与 address(默认 127.0.0.1:8384);找 id 对应 path=`/home/xxc/kb` 的 folder;`GET /rest/config/devices` 拿设备友好名;对每设备 `GET /rest/db/completion?folder=<id>&device=<devId>` 得 completion%。**apikey 只在服务端使用,响应里绝不出现**。syncthing 不可达 → `remote: null`,面板该卡显示"syncthing 不可达"(不算错误)。本机自身设备跳过。
- D6(数据层):`lib/backup-status.ts` 增纯函数 `parseIndexLog(text)`(行格式 `ISO\t大小(人类可读)\t绝对路径`,文件名里提取归档名与 UTC 时间戳,复用 parseBackupFilename;bad line 跳过)+ `collectBackupStatus` 合并 archives ∪ log 去重(以归档名为键),log 独有条目标 `rotated: true`;新 `lib/backup-mutations.ts`(run-backup spawn / verify / 下载文件名校验)。解析纯函数进 `lib/backup-status.test.mjs` 补测试(含轮转条目、坏行、120M 异常样例)。
- D7(风格):沿用仓库 inline-style + CSS 变量惯例,不引图表库;i18n key `backups.*` 两语言文件对齐追加;按钮/折叠参照 AsyncTasksPanel 的 buttonStyle 模式。

## 数据源 / 上下文(自包含)

- 仓库:`/home/xxc/XcRepository/02-Agents/pi-web`(Next.js 16 + React 19,inline-style,主题 CSS 变量)。测试命令:`env -u PI_WEB_PASSWORD npm test`;类型:`node_modules/.bin/tsc --noEmit`;lint:`npm run lint`。
- 备份目录 `~/kb/pi-backups/`:`pi-backup-<host>-<YYYYMMDD>T<HHMMSS>Z.tar.gz.gpg` + 同名 `.sha256` 旁文件;保留 14 份(脚本轮转);`index.log` 每行 `<ISO本地时间>\t<du大小如12M>\t<绝对路径>`(含已轮转条目,历史 120M 异常在 log 里)。
- 备份脚本:`~/bin/pi-backup.sh`,crontab 22:00 每日跑,stdout 在 cron 里重定向到 `~/.pi/backup.log`。校验语义:`sha256sum -c <archive>.sha256`(在备份目录内执行,退出码 0=通过)。
- syncthing:config `~/.local/state/syncthing/config.xml`(folder id 需按 path=`/home/xxc/kb` 反查,别硬编码;设备 id/name 从 `<device>` 元素取);REST 需要 header `X-API-Key`。本机自身 device id 可从 `<device id=...>` 中配置在本 GUI 的那个(或跳过 completion 为 100% 的本机——实现从简:列出所有远端设备,本机 device 元素无 name 引用时用 id 前 7 位)。
- 参考组件:`components/AsyncTasksPanel.tsx`(全屏容器/抽屉/toast/轮询模式),`app/api/async-tasks/route.ts`(POST action 分发模式),`lib/async-mutations.ts`(spawn detached 模式)。

## 硬性约束

- **独立任务,与此前对话无关。**
- 改动白名单:
  - 改:`components/BackupsPanel.tsx`(重写允许)、`lib/backup-status.ts`、`app/api/backups/route.ts`、`lib/backup-status.test.mjs`、`lib/i18n/messages/zh-CN.ts` 与 `en.ts`(仅 `backups.*` 段追加/微调)
  - 新:`lib/backup-remote.ts`、`lib/backup-mutations.ts`(命名可微调,但必须是新文件)
- 禁动:`components/AsyncTasksPanel.tsx`、`lib/async-*`、`app/api/async-tasks/**`、`hooks/**`、`components/AppShell.tsx`(面板挂载方式不变,BackupsPanel 导出名与 props 不变)、其他一切。
- 禁令:禁跑 `next build` / `npm run dev`(归父会话);禁 `npm install`;禁 commit;`~/kb/pi-backups/` 与 `~/bin/pi-backup.sh` 生产数据只读(校验动作只 `sha256sum -c`,不许触发真实备份——run-backup 的 spawn 逻辑写好即可,不实际调用验证)。
- syncthing apikey 绝不出现在任何客户端可达的响应/日志/错误信息里。

## 验收标准

1. `env -u PI_WEB_PASSWORD npm test` 全绿(新增解析测试 ≥5 个用例);`tsc --noEmit` 零输出;`npm run lint` 零报错。
2. 逻辑自查(代码走查或 mock):热力条 14 天聚合正确(缺备份日红);趋势图 30 份上限、>50MB 标红;下载文件名校验拒绝 `../` 与非归档名;remote 不可达时面板不报错。
3. `git status` 无白名单外文件、无锁文件变更。
4. 交付:改动总结 + 各决策点(D1-D7)落点说明 + 遗留问题清单(含未实际执行 run-backup 的说明)。

## 结果记录

- 受托方:herdr omp(w1:t3, agent backupv2)。交付:D1-D7 全落地,数据层 183 行增量(轮转合并/热力聚合/下载校验),UI 325 行增量(全屏四区块+操作闭环),新增测试 14 例。
- 父会话验收:三件套全绿(619 pass/0 fail、tsc/lint 干净);git status 严格白名单(6 改+2 新+任务书);apikey 零泄漏走查;下载路径双校验(basename+归档正则)确认。
- 回流决策:D4 变体——下载路由用同文件 query 参数(?download=)而非新 route 文件,因白名单禁新 API 目录;逻辑隔离在 resolveArchivePath,后续放开白名单可一行迁移。已接受。
- 遗留处置:latestVerify 内存缓存重启失效(任务书已接受);pgrep 不可用时防重降级乐观放行;跨时区访问时热力分界以服务器时区为准(本机自用无影响)。
