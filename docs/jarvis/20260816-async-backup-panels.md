# 异步任务 + 备份链可视化面板（V1）

```
status: done
version: 1
created: 2026-08-16
pipeline: subagent-worker
```

## 背景与目标

pi-web 官方版不满足需求：异步任务框架（second-brain `[[jarvis-async-tasks]]`）与备份链（`[[pi-backup-plan]]`）缺可视化管理入口。目标：两个只读可视化页面。补档说明：本任务书为收口后追溯归档（原始任务以 subagent task 参数发出，未存档；2026-08-17 建档制度后补）。

## 决策记录

- D1: 入口用侧边栏按钮开全屏面板，不做独立路由页——跟随仓库既有惯例（ModelsConfig/PluginsConfig 模式）（实现期受托方按仓库惯例自适应，父会话追认）
- D2: V1 严格只读，无执行/删除按钮——操作类涉及权限模型，V2 再议
- D3: 最小 diff——新文件为主，老文件白名单仅 `AppShell.tsx`（导航入口）+ i18n 词条两文件
- D4: 数据层纯函数拆独立无 Node import 模块（`lib/cron-describe.ts`）——集成期 build 炸（client bundle 拖入 fs/child_process）后父会话修复时定，教训详见项目笔记

## 数据源 / 上下文（自包含）

- 任务书/完成标记/运行日志/失败日志/保夜开关/守卫日志：`~/.pi/async-tasks/`（命名约定 `run-<name>.log`、`.done-<name>`、`failed-<name>-<YYYYMMDD>.log`）
- cron 调度：`crontab -l` 过滤 `async-task.sh` 行
- 备份包：`~/kb/pi-backups/pi-backup-<host>-<YYYYMMDD>T<HHMMSS>Z.tar.gz.gpg` + `.sha256` 旁文件；RPO 目标 24h
- 备份脚本（只读提取范围说明）：`~/bin/pi-backup.sh`

## 硬性约束

- 改动白名单：`components/AppShell.tsx` + `lib/i18n/messages/{en,zh-CN}.ts`；其余新文件
- 对上述数据源**只读**，绝不写/删
- 禁跑 `next build`（归父会话）；测试须过 `npm test` / `tsc --noEmit` / `npm run lint`

## 验收标准

- 三件套全绿；数据解析函数有测试覆盖；双语 i18n；空态优雅

## 结果记录（done 时填）

- commit(s): `af78741`（面板实现）、`16f79dd`（D4 纯函数拆分修复）
- 交付：lib 数据层×2 + cron-describe + API route×2 + 面板组件×2 + 测试×2；605/605 绿
- 遗留处置：远端副本接入/sha256 实校验/操作按钮 → backlog（项目笔记）
