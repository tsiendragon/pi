# TSIEN_FORK.md — `tsien` 分支说明

本仓库是 [earendil-works/pi](https://github.com/earendil-works/pi) 的个人分支（fork），承载本机与
其他几台机器需要的少量补丁，同时保持能定期同步官方上游。

| 项 | 值 |
|---|---|
| fork（`origin`） | `git@github.com:tsiendragon/pi.git` |
| 上游（`upstream`） | `https://github.com/earendil-works/pi.git`（push URL 已设为 `no_push`，防误推） |
| 基线 | `71dca87`（`v0.85.1-67-g71dca871b`，官方 v0.85.1 之后第 67 个 commit） |
| 补丁分支 | `tsien`（12 个 commit，最新 `c67d169`） |
| 版本号 | `0.85.1-tsien.1`（带 `-tsien.N` 后缀，避免与官方包混淆） |
| 分发方式 | 本地构建的 tgz，作为 GitHub Release 资产（**不发 npm**） |

## 1. 分支与远端布局

| 名称 | 内容 | 规则 |
|---|---|---|
| `main` | 上游 `upstream/main` 的纯镜像 | 只 `git merge --ff-only upstream/main`，**不提交** |
| `tsien` | 基线 + 全部补丁 commit | 所有改动都在这里，靠 `git rebase` 同步上游 |
| `origin` | 自己的 fork | `remote.pushDefault=origin`，只推这里 |
| `upstream` | 官方 | 只 fetch；push URL = `no_push` |
| `rerere.enabled` | `true` | rebase 冲突的解法可复用 |

补丁越少越好：能不提上游的就不写进 `tsien`，能合并成一个 commit 的就不拆。

## 2. 补丁清单（`71dca87..tsien`）

| commit | 作用 |
|---|---|
| `1e3f6a13` | `feat(tui)` 扩展独立全屏路由：`custom()` 支持 `fullscreen`，`WidgetPlacement` 新增 `aboveStatus` |
| `5be1db36` | `feat(extensions)` 安全嵌套工具调用：`ExtensionAPI.executeTool` |
| `fb4e15a3` | `feat(tui)` 常规 TUI 布局调整 |
| `6c0be80e` | `feat(extensions)` 多通道 UI 请求总线：`extension_ui` 事件 + `respondExtensionUi` |
| `c18d5df0` | `feat(coding-agent)` 默认 system prompt（`getDefaultSystemPrompt`） |
| `1d0b75bc` | `fix(coding-agent)` 紧凑布局下保留编辑器 |
| `df471722` | `fix(ai)` 把 `@google/genai` 的 `TOO_MANY_TOOL_CALLS` 映射为错误 |
| `66825672` | `feat(extensions)` `ctx.ui.notify` 投影为 `extension_ui_notify` |
| `d6122619` | `fix(tui)` 删除未使用的 `os` import |
| `141fee77` | `docs` 记录本地 pi 安装与 NFS 启动开销（`AGENTS.md`） |
| `839dd0cf` | `chore(release)` 版本号 `0.85.1-tsien.1`（23 个文件 + shrinkwrap/install-lock 重新生成） |
| `c67d1690` | `fix(ai)` 数据源改名时不再静默删除仍被引用的 provider 分片（对应上游 issue #10036） |

### 相对官方 npm 包多出的 API（配套扩展依赖，官方至今没有）

| API | 引入 commit | 消费方 |
|---|---|---|
| `ExtensionAPI.executeTool` | `5be1db36` | pi-dashboard `ptc.ts`（`run_code`）、subagent-workbench `multi-tool.ts` |
| `ExtensionAPI.respondExtensionUi` + 事件 `extension_ui` | `6c0be80e` | pi-dashboard `live-session.ts` |
| 事件 `extension_ui_notify` | `66825672` | pi-dashboard `live-session.ts` |
| `WidgetPlacement.aboveStatus` | `1e3f6a13` | subagent-workbench `task-navigation.ts` |
| `custom()` 的 `fullscreen` | `1e3f6a13` | pi-dashboard `conversation-workbench.ts` |

## 3. 构建与发布

### 硬约束：不要跑真实的 `npm run generate:models`

`scripts/local-release.mjs` 会先跑 `npm run generate:models`，它会从 `https://models.dev/api.json`
**现拉**数据重新生成模型目录（含被 gitignore 的 `packages/ai/src/providers/data/`）。当前线上数据已与
仓库提交的分片、以及仓库自带测试的断言漂移（例如 `glm-5.2` → `glm-5.3`），会让 `tsgo --noEmit` 失败。
因此发布构建使用**钉住的同世代目录快照**，并把 `generate:models` 临时改成 no-op：

```bash
# 1) 临时把 generate:models 变 no-op
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("package.json","utf8"));j.scripts["generate:models"]="true";fs.writeFileSync("package.json",JSON.stringify(j,null,2)+"\n")'
# 2) 构建（约 2 分钟，产出 10 个 tgz）
node scripts/local-release.mjs --out ~/pi-local-release-tsien --force --skip-check --skip-test --skip-install
# 3) 还原
git checkout -- package.json
```

`packages/ai/src/providers/data/` 不进版本库。新机器 clone 后若缺这份数据，从已安装的 pi-ai 整份复制：

```bash
cp -a <prefix>/lib/node_modules/@earendil-works/pi-ai/dist/providers/data/. packages/ai/src/providers/data/
(cd packages/ai && npm run check:model-data)   # 期望：Generated model data is valid.
```

### 发布前验证清单（缺一不可）

```bash
D=~/pi-verify; npm install -g --prefix "$D" ~/pi-local-release-tsien/tarballs/*.tgz
"$D/bin/pi" --version                                    # 期望 0.85.1-tsien.N
rg -c executeTool "$D"/lib/node_modules/@earendil-works/pi-coding-agent/dist -g '*.d.ts'
ls "$D"/lib/node_modules/@earendil-works/pi-ai/dist/providers/data/*.json | wc -l    # 期望 39
"$D/bin/pi" -p "Use the run_code tool to compute 2+2, then reply with only the numeric result."   # 期望 4
```

发布后再核对资产完整性：

```bash
for f in ~/pi-local-release-tsien/tarballs/*.tgz; do
  b=$(basename "$f")
  curl -sL -o "/tmp/$b" "https://github.com/tsiendragon/pi/releases/download/<tag>/$b"
  sha256sum "$f" "/tmp/$b"          # 两个哈希必须一致
done
```

## 4. 同步上游

```bash
git fetch upstream
git merge --ff-only upstream/main          # 更新 main 镜像
git rebase upstream/main tsien             # 或 git rebase --onto upstream/main <旧基线> tsien
```

rebase 后必做：

1. 处理冲突时**修根因**，不要为了少改而放弃补丁语义；`rerere` 会复用上次解法。
2. **递增版本号**（`-tsien.N`），并按需重新生成 shrinkwrap / install-lock（`npm run check` 会校验）。
3. 若上游动了 provider 数据或测试：注意上面的数据目录漂移问题，必要时从新版已安装 pi-ai 取同世代数据。
4. 重新构建 + 走完验证清单，再打**新 tag**（例如 `v0.86.0-tsien.1`）。tag 是构建产物的来源，**不要**移动或强推已发布的 tag。
5. 提交前 husky 会跑全套 `npm run check`（biome + 9 项检查 + `tsgo --noEmit`），全绿才提交。

### 4.1 已实测：rebase 到官方 1.6.1（2026-11）

13 个定制 commit 全部重放到 `upstream/main`（1.6.1，含 #12273 缓存修复）。冲突解决留档：

| 定制 commit | 上游变化 | 融合方式 |
|---|---|---|
| 扩展全屏路由 | `showExtensionCustom` 重写为对话框栈 + `extensionOverlays` + `programStatus` | fullscreen 分支并入新结构；`ExtensionUICustomOptions` 保留 `fullscreen` 并补入上游 `blocked` 字段 |
| 安全嵌套工具调用 | 上游另有 `ExtensionToolContext.executeTool`（工具上下文层） | 二者并存：定制的是 `ExtensionAPI.executeTool`（扩展层），签名不同不冲突 |
| TUI 布局优化 | `Component.render` 返回类型改 `readonly string[]` | 定制代码跟随新签名 |
| 多通道 UI 请求总线 | `select/confirm/input/editor` 改走对话框栈 | `signal`/abort 逻辑迁移到 `pushExtensionDialog`/`removeExtensionDialog` |
| 默认 system prompt | 系统提示改为分节结构（`promptSections`） | `defaultSystemPrompt` 改为覆盖 `preamble`，其余分节沿用上游 |
| 紧凑布局保留 editor | 上游超宽行改为写崩溃日志 + `stop()` + 抛错 | 取折中：写诊断日志后裁剪，不终止会话；两条上游测试改写为新约定 |
| genai `TOO_MANY_TOOL_CALLS` | 上游已内建该 case | 仅保留说明性注释 |
| `extension_ui_notify` | 上游 `on()` 返回 `() => void` 且事件更多 | 采用上游签名与事件表，补入 `extension_ui_notify` |
| providers 重命名保护 | 生成器迁到 `packages/ai/catalog/generate.ts` | 保护逻辑移植到新脚本（保留 shard 删除前的 orphan 检查）|
| 版本号 `0.85.1-tsien.1` | 上游 1.6.1，且删除了 `client`/`protocol`/`server`/`session-backends` | 版本统一为 `1.6.1-tsien.1`；依赖跟上游（不引入已删包）；`npm-shrinkwrap.json` 与 sandbox 示例接受上游删除 |

本轮新增两个上游没有的提交：

- `fix(ai): keep PI_AI_VERSION in sync with the fork version` —— `scripts/sync-versions.js` 在本仓库会抛错（排序时读到 undefined 的包名），故直接改常量，否则 `identity.test.ts` 失败。
- `style: apply biome formatting after the rebase` —— 预提交钩子的格式化结果。

已知与上游一致的测试基线：`packages/ai` 的 Anthropic OAuth / E2E 类测试需要真实凭据，上游 main 上同样失败（上游 9 文件 / 26 用例失败，本分支 7 文件 / 24 用例失败）。跑这些包前先 `unset PI_SKIP_VERSION_CHECK`，否则 `version-check.test.ts` 会因早退而假失败。

数据目录提醒：`packages/ai/src/providers/data/` 是 gitignore 的生成产物，干净检出后需先跑
`cd packages/ai && node catalog/generate.ts --strict`；Node 22.19 自带的类型剥离可能不可用，可改用
`/home/tsien/pi-stack/runtime/node-v22.23.5-linux-x64/bin/node`。

## 5. GitHub 写操作用 `tsiendragon` 身份

`git push` 走 SSH（本机 key 已是 `tsiendragon`），**不需要 token**。需要 GitHub API 写操作（提 issue、
发 Release）时，token 存在 Sekret，注入子进程使用，**不要**打印、导出或持久化 token 值：

```bash
S=/mnt/workspace/lilong/envs/conda/envs/train/bin/sekret
"$S" local exec tsien account -- /usr/bin/bash -c \
  'GH_TOKEN="$GH_TSIEN_TOKEN" gh issue create --repo earendil-works/pi --title "..." --body-file <file>'
```

要点：vault `account` 里另有 `GITHUB_PR_TOKEN`（另一个账号），所以要显式把 `GH_TOKEN` 指向
`GH_TSIEN_TOKEN`（`gh` 的优先级是 `GH_TOKEN` > `GITHUB_TOKEN`）。该 token 只需 classic 的
`public_repo` 权限即可覆盖「给上游提 issue」与「给本 fork 发 Release」，用完请撤销。

## 6. 备份与回滚

| 资产 | 路径 |
|---|---|
| 整理前的 16 commit bundle | `/home/tsien/pi-tsien-16commits.bundle` |
| 整理前的 16 个 patch | `/home/tsien/pi-tsien-patches/` |
| 整理前的分支 | `backup/feat-tsien-20260925` |

已 drop：`d7b8339 test(tui): drop crash-dump test superseded by clip behavior` —— 上游已用新测试
重写了同一处行为，保留它只会增加 rebase 冲突。

## 7. 已知未验证项

- 未跑全量 `./test.sh`（只跑了发布所需的针对性验证与 `npm run check`）。
- 未生成 bun 单文件二进制（本机无 bun）。
- pi-dashboard 的 live-session 对话框镜像未在真实会话里实跑。
- `c18d5df0` 引入的 `getDefaultSystemPrompt` 当前无调用方，疑似冗余；删除属行为变更，保留待验证。

## 8. 关联的上游问题

- `c67d1690` 修的是上游 bug（生成器静默删除仍被手写 provider import 的分片），已提：
  <https://github.com/earendil-works/pi/issues/10036>。若上游合并了等价修复，本条补丁可在 rebase 时移除。
### 4.2 已实测：1.6.1-tsien.1 发布构建与 sol 缓存验证（2026-11-27）

**运行时必须是 Node ≥ 22.23。** `packages/ai/scripts/check-model-data.ts` 与
`catalog/generate.ts` 直接用 Node 原生 TypeScript 类型剥离跑 `.ts`。本机 `/usr/bin/node`
是 v22.22.1（`process.features.typescript === false`），会在 `build:offline` 的第一步
`ERR_UNKNOWN_FILE_EXTENSION` 挂掉，`produceArtifactSet` 一个 tgz 都产不出来。把
`/home/tsien/pi-stack/runtime/node-v22.23.5-linux-x64/bin` 置前 PATH 即可。打包报
「`.ts` 扩展名未知」时先查这一条，不要去翻依赖或 `files` 配置。

**rebase 时 `chore(release)` 冲突解掉了两个包的元数据。** `packages/mcp/package.json` 丢了
`name` 与 `description`、`packages/chord/package.json` 丢了 `description`。前者让
`npm pack` 报 `Invalid package, must have name and version`，打包在 pack 阶段中断（已产出 7 个
tgz、无 manifest）。rebase 后核对元数据：把每个 `packages/*/package.json` 与
`upstream/main:` 的同名文件按「除版本号外字段」逐一比对。

**「同世代 provider 数据」的判据是仓库自己的测试，不是 npm 包。** `upstream/main` 已比
`v1.6.1` tag 前进（例如 `9627ebab8 feat(ai): load Ant Ling models from models.dev`），所以
官方 `pi-ai@1.6.1` 发布包里的 `dist/providers/data/` 已经比本分支提交的 shard 与测试**旧**：
用它替换后 `tsc --noEmit` 报 3 处错误（测试写 `Ling-3.1-flash`，官方数据只有 `Ling-2.6-*`）。
反过来，跑过 `npm run generate:models` 现拉下来的数据与提交的 shard/测试一致，`tsc --noEmit`
干净。因此本轮的取舍是：**保留同一次现拉得到的生成产物，但落地归档，不再现拉**——判据是可
复现的（下方命令），不是「有没有联网」。

```bash
# 判据：数据与提交的 shard/测试同一世代吗？
(cd packages/ai && npm run check:model-data)   # 结构 + manifest 哈希
npx tsc --noEmit                               # 类型层真正比对数据与测试断言
```

`check:model-data` 只校验**结构**（文件集合、`type:id` identity、API 分组、manifest 哈希），
不校验数值，所以漂移数据和恢复后的数据都能通过它；能不能过 `tsc --noEmit` 才是世代判据。

**发布实测结果（1.6.1-tsien.1，13 个定制 commit 全在）**

| 检查项 | 结果 |
|---|---|
| `local-release.mjs --skip-check --skip-test --skip-install` | 11 个 tgz + `manifest.json` |
| `pi --version`（`~/pi-verify`） | `1.6.1-tsien.1` |
| `rg executeTool dist -g '*.d.ts'` | 21 处命中（`ExtensionAPI.executeTool` 在 `core/extensions/types.d.ts`） |
| `pi-ai/dist/providers/data/*.json` | 43 个 provider 分片（+`.manifest.json`） |
| `pi -p "run_code 2+2"` | `4`（**须用 Node 22.23.5 启动**，否则 Code Mode 沙箱探测失败、`run_code` 被禁用） |

**#12273 缓存命中率 A/B 实测。** 同一会话、`openai-codex/gpt-6.2-sol`、连续 7–8 个短请求，
读 `message_end` 的 `usage`（`PI_TRACE_DIR` 留 `provider_request` 供结构核对）：

| 侧 | 版本 | payload 顶层 `instructions` | 预热轮命中率（中位数） | 范围 |
|---|---|---|---|---|
| 修复前 | 官方 `1.5.2`（`edfe6b2ef` 之前的最近发布） | **有** | **44.46%**（n=15，3 次试验） | 44.32–44.71% |
| 修复后 | 本分支发布产物 `1.6.1-tsien.1` | **无**，system prompt 是 leading `developer` 项 | **98.03%**（n=7，最终产物）／**97.97%**（n=20，含中间构建） | 95.85–98.48% |

修复前天花板≈44–54%：`instructions` 每轮让 system prompt 失效，只有会话内容可缓存；修复后
稳定≈98%，剩余 2% 是每轮新增的 user/assistant 增量。稳态单轮规模也印证了原因：system prompt
约 10.2K token，修复前 `cacheRead` 只覆盖会话增量（~4.6K）、每轮重付 ~5.7K；修复后
`cacheRead≈10.2K`、每轮只剩 ~200 token 新增。中途整轮 `cacheRead=0` 是服务端缓存
过期（偶发，两侧都会出现），不代表修复失效。复现脚本：

```bash
bash scratch/cache-sol.sh <pi-bin> <trace-dir> <session-id> <label>   # 跑 6 个短请求并打印逐轮命中率
python3 scratch/cache-report.py before=/tmp/a/turns.jsonl fixed=/tmp/b/turns.jsonl
python3 scratch/payload-account.py <fixed-trace> <before-trace>       # 核对 instructions / developer 放置
```

注意：验证 `run_code` 与缓存时都要用 `~/pi-verify/bin/pi`，不要把生产 `~/pi-stack/pi` 换掉。
