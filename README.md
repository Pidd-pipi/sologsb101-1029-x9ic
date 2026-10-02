# 影视场景连戏与道具接续核对台（gbcontinuity）

面向剧组场记与服装道具部门的本地化核对工具：把剧本场次拆成连戏要素清单，按拍摄日逐条记录现场服装、道具、妆发与陈设的实际状态，自动比对同一场景在不同拍摄日之间的差异，提示冲突并跟踪解决，最后生成连戏核对报告。

核心动作：**建场次与拍摄顺序 → 登记连戏要素 → 录现场状态与镜次 → 比对差异 → 消解冲突并导出报告**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22829**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbcontinuity}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出场记交接包 / 离线交接导入」（按记录编号合并，不覆盖对方新录内容），整库覆盖恢复仅作为旧备份应急入口。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、下拉菜单交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22829 |
| 状态管理 | Pinia（setup store） | `sceneStore` / `elementStore` / `recordStore` / `conflictStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbcontinuity-db`，结构版本 v2，含 upgrade 迁移；业务 5 表 + 交接 3 表（基线 / 待裁决 / 待处理包） |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22829
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22829）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/scenes` | 剧本场次与拍摄顺序台账 | Scene、Conflict | 新建/编辑/删除场次、**拖拽调序并自动重编号**、按内外景与日/夜筛选、卡片回显要素数与未解决冲突数、筛选同步 URL query |
| `/elements` | 连戏要素登记 | Element、Scene | 按场次与类别分组展示、维护初始状态与责任人、关键要素标记与高亮、增删改 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Element | 建立拍摄日并勾选当日场次、按镜次逐条录入当前状态与照片说明、同要素保留历次快照、记录差异角标 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record | **重新比对生成差异**、并排展示记录 A / 记录 B、严重程度与解决状态流转、解决后回写要素初始状态并留痕 |
| `/report` | 连戏核对报告与离线交接 | 全部模型、MergeIssue、IncomingPackage | 场次核对小结、风险分、**按记录编号的离线交接导入 / 待裁决两版并排选定 / 出错留档重试**、来源 · 待裁决 · 失效数量徽标、报告 / 整库 JSON 导出 |

---

## 五、目录结构

```
sologsb101-1029/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # scene.ts element.ts shootDay.ts record.ts conflict.ts filter.ts
        ├── stores/             # sceneStore elementStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useContinuityDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts export.ts handoff.ts device.ts seed.ts uuid.ts query.ts
        ├── pages/              # SceneList ElementRegistry ShootDayLog ConflictBoard ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`，当前结构版本号 `version(2)`；`version(1)→(2)` 带 `upgrade()` 迁移（为历史行补来源标记，播种行按固定 ID 识别为「演示数据」）。
- **分表存储**：`scenes` 场次、`elements` 连戏要素、`shootDays` 拍摄日、`records` 现场记录、`conflicts` 连戏差异，共 5 张业务表；每行带 `revision` / `createdAt` / `updatedAt` / `origin`（最后修改来源设备）。离线交接另设 `syncState`（对端基线）、`mergeIssues`（两边都改的两版待裁决）、`incomingPackages`（待处理包与出错留档）三张表。
- **设备身份**：设备 ID 存 localStorage（终身不变），设备名可在报告页改为「外景车 / 驻地」；本机新建与编辑的行自动打本机标记，交接并入的行打对端标记，页面用 `OriginTag` 标出来源。
- **离线交接（按记录编号，不整库覆盖）**：导出「场记交接包」（带设备身份与时间戳），对端导入时以上次交接基线做三方合并——对端新增 / 单边改过的场次、连戏要素、拍摄日、现场记录直接并入；**同一条两边都改则两版都进 `mergeIssues` 保留**，在报告页并排展示，等场记选定后才写入。首次与某台设备交接且无共同基线时，按来源启发式判定（本机演示行未动直接接收），无法证明单边修改的一律进待裁决，绝不静默覆盖。
- **裁决即重算**：现场记录落定（并入或裁决写入）后立即重算差异表——关联记录缺失或两版已无差异的旧条目标 `invalidated` 留痕保留（页面灰化、可开关查看，不删、不复活、不进待确认统计），新差异自动生成，核对报告同步刷新。
- **出错保留**：导入先校验再整体进单个事务，任一行失败全部回滚（当前库不动），原包存入 `incomingPackages` 标「出错」可改后重试；旧版整库备份（无设备字段、无时间戳）也能作为交接包并入，来源标「旧备份」。整库覆盖恢复仍保留，但在报告页作为独立的高风险入口并需二次确认。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入互相引用的三层演示数据（场次 → 连戏要素 → 拍摄日 → 现场记录 → 差异），其中包含 1 条「阻断 / 待确认」与 1 条「轻微 / 待确认」差异，保证差异页与报告页首次打开就有内容；播种幂等，演示行来源统一标「演示数据」。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去掉空白与标点、颜色/款式同义写法归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键要素的状态变化判为「阻断」，一般要素的状态变化判为「需处理」，仅照片说明 / 镜次变化判为「轻微」。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **级联规则**：删除场次会级联删除其要素、现场记录、相关差异及对应的待裁决条目；删除拍摄日会删除当日记录、相关差异与待裁决条目。

### 典型离线作业流程（外景车 / 驻地）

1. 两台笔记本各自在报告页把设备名改成「外景车」「驻地」。
2. 断网前（或任意时点）各自点「导出场记交接包」，得到带设备身份的 JSON。
3. 断网期间两边各自录场次、要素、拍摄日与现场记录。
4. 回到一起后互发交接包，各自在报告页「离线交接」处导入：新增和单边改动自动并入；同一条两边都改的会出现在「待场记裁决」里，两版字段并排（差异字段红字标出），选定后写入。
5. 现场记录一写定，差异条目与核对报告立即重算；失效差异灰化留痕，页面徽标实时显示来源条目数、待裁决数与因合并失效数。
6. 导入解析失败或合并报错时当前库不变，包留在「待处理包与出错留档」里，修正后点重试即可。
