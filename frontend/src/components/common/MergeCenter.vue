<script setup lang="ts">
/**
 * MergeCenter：离线交接中心（嵌入核对报告页）。
 * - 导出场记交接包（带设备身份）
 * - 导入按记录编号合并：新增 / 单边改直接并入，两边都改保留两版待场记裁决
 * - 待裁决两版并排、选定后写回，现场记录落定立即重算差异
 * - 导入出错保留当前库与待处理包，可改后重试；旧备份也能参与合并
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, FolderOpened, RefreshLeft, Delete } from '@element-plus/icons-vue'
import {
  db,
  type ElementRow,
  type IncomingPackageRow,
  type MergeIssueRow,
  type SceneRow,
  type ShootDayRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  decideMergeIssue,
  importHandoffText,
  downloadHandoff,
  formatSummary,
  retryIncomingPackage,
  TABLE_LABELS,
  type MergeSummary
} from '@/utils/handoff'
import { getDeviceName, setDeviceName } from '@/utils/device'
import OriginTag from './OriginTag.vue'

const { rows: issues } = useIdbTable<MergeIssueRow>(() => db.mergeIssues)
const { rows: packages } = useIdbTable<IncomingPackageRow>(() => db.incomingPackages)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays, {
  compare: (a, b) => b.date.localeCompare(a.date)
})

const deviceName = ref(getDeviceName())
const pendingIssues = computed(() => issues.value.filter((item) => item.state === '待裁决'))
const decidedCount = computed(() => issues.value.length - pendingIssues.value.length)
const errorPackages = computed(() => packages.value.filter((item) => item.status === '出错'))
const mergedPackages = computed(() => packages.value.filter((item) => item.status === '已并入'))

async function saveDeviceName(): Promise<void> {
  const next = deviceName.value.trim()
  if (!next) {
    ElMessage.warning('设备名不能为空')
    deviceName.value = getDeviceName()
    return
  }
  setDeviceName(next)
  deviceName.value = next
  ElMessage.success(`本机已标记为「${next}」，之后导出的交接包都会带来源`)
}

async function onExport(): Promise<void> {
  await downloadHandoff()
  ElMessage.success('交接包已导出，交给另一台笔记本导入即可')
}

/* ------------------------------ 导入 ------------------------------ */

const importInput = ref('')
const importFilename = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

function triggerFile(): void {
  fileInput.value?.click()
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importFilename.value = file.name
  importInput.value = await file.text()
  input.value = ''
  ElMessage.success(`已读取文件 ${file.name}，确认后按记录编号合并`)
}

async function pasteImport(): Promise<void> {
  const { value } = await ElMessageBox.prompt('粘贴对方交接包 / 旧备份 JSON 内容（按记录编号合并，不会覆盖你的新记录）', '导入交接包', {
    inputType: 'textarea',
    confirmButtonText: '确认并入'
  })
  importInput.value = value
  importFilename.value = ''
  await doImport()
}

async function doImport(): Promise<void> {
  const text = importInput.value.trim()
  if (!text) {
    ElMessage.warning('请先选择文件或粘贴交接包内容')
    return
  }
  try {
    const summary = await importHandoffText(text, importFilename.value || '粘贴导入')
    ElMessage.success(`并入完成：新增/改并已落库，${totalConflicts(summary)} 条两边都改、待裁决`)
    importInput.value = ''
    importFilename.value = ''
  } catch (error) {
    ElMessage.error(`并入失败，当前库未改动、待处理包已保留：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function totalConflicts(summary: MergeSummary): number {
  return summary.conflicts.scenes + summary.conflicts.elements + summary.conflicts.shootDays + summary.conflicts.records
}

async function retryPackage(row: IncomingPackageRow): Promise<void> {
  try {
    const summary = await retryIncomingPackage(row)
    ElMessage.success(`重试成功：${formatSummary(summary)}`)
  } catch (error) {
    ElMessage.error(`仍无法并入：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function removePackage(row: IncomingPackageRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该待处理包不影响当前库数据，是否继续？', '删除留档包', { type: 'warning' })
  } catch {
    return
  }
  await db.incomingPackages.delete(row.id)
  ElMessage.success('留档包已删除')
}

/* ------------------------------ 裁决 ------------------------------ */

interface FieldDef {
  key: string
  label: string
  resolve?: (value: unknown, issue: MergeIssueRow) => string
}

const FIELD_DEFS: Record<MergeIssueRow['table'], FieldDef[]> = {
  scenes: [
    { key: 'sceneNo', label: '场号' },
    { key: 'place', label: '内外景' },
    { key: 'timeOfDay', label: '时间' },
    { key: 'location', label: '地点' },
    { key: 'excerpt', label: '剧本节选' },
    { key: 'shootOrder', label: '拍摄顺序' },
    { key: 'state', label: '状态' }
  ],
  elements: [
    { key: 'sceneId', label: '所属场次', resolve: (v) => scenes.value.find((item) => item.id === v)?.sceneNo ?? String(v ?? '—') },
    { key: 'category', label: '类别' },
    { key: 'name', label: '名称' },
    { key: 'initialState', label: '初始状态' },
    { key: 'owner', label: '责任人' },
    { key: 'critical', label: '关键要素', resolve: (v) => (v ? '是' : '否') }
  ],
  shootDays: [
    { key: 'date', label: '拍摄日期' },
    {
      key: 'sceneIds',
      label: '当日场次',
      resolve: (v) => Array.isArray(v) ? v.map((id) => scenes.value.find((item) => item.id === id)?.sceneNo ?? id).join('、') : '—'
    },
    { key: 'director', label: '导演' },
    { key: 'scripty', label: '场记' },
    { key: 'weatherNote', label: '现场备注' }
  ],
  records: [
    {
      key: 'shootDayId',
      label: '拍摄日',
      resolve: (v) => shootDays.value.find((item) => item.id === v)?.date ?? String(v ?? '—')
    },
    {
      key: 'elementId',
      label: '连戏要素',
      resolve: (v) => elements.value.find((item) => item.id === v)?.name ?? String(v ?? '—')
    },
    { key: 'takeNo', label: '镜次' },
    { key: 'currentState', label: '当前状态' },
    { key: 'photoNote', label: '照片说明' },
    { key: 'recordedBy', label: '记录人' }
  ]
}

function fieldText(issue: MergeIssueRow, side: 'local' | 'incoming', def: FieldDef): string {
  const raw = side === 'local' ? issue.local : issue.incoming
  const value = raw[def.key]
  const text = def.resolve ? def.resolve(value, issue) : String(value ?? '')
  return text || '空'
}

async function decide(issue: MergeIssueRow, choice: 'local' | 'incoming'): Promise<void> {
  const target = choice === 'local' ? '本机版本' : `${issue.peerDeviceName}版本`
  try {
    await ElMessageBox.confirm(
      `确定把编号 ${issue.recordId} 的${TABLE_LABELS[issue.table]}写为${target}？${issue.table === 'records' ? '写定后差异条目与核对报告会立即重算。' : ''}`,
      '裁决确认',
      { type: 'warning', confirmButtonText: '确认写入' }
    )
  } catch {
    return
  }
  await decideMergeIssue(issue.id, choice)
  ElMessage.success(`${target}已写入`)
}

function formatTime(value: number): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-Hans-CN', { hour12: false })
}

function originOf(issue: MergeIssueRow, side: 'local' | 'incoming'): string {
  const raw = side === 'local' ? issue.local : issue.incoming
  return typeof raw.origin === 'string' && raw.origin ? raw.origin : side === 'local' ? getDeviceName() : issue.peerDeviceName
}
</script>

<template>
  <el-card shadow="never" class="merge-center">
    <template #header>
      <div class="card-title">
        <span><el-icon><Connection /></el-icon> 离线交接（按记录编号合并）</span>
        <span class="muted">外景车 / 驻地断网各改各的，回来只并新增与改动，绝不整库覆盖</span>
      </div>
    </template>

    <div class="badge-row">
      <el-tag type="danger" size="large" effect="dark">待裁决 {{ pendingIssues.length }}</el-tag>
      <el-tag type="info" size="large" effect="plain">已裁决 {{ decidedCount }}</el-tag>
      <el-tag type="warning" size="large" effect="plain">出错留档 {{ errorPackages.length }}</el-tag>
      <el-tag type="success" size="large" effect="plain">已并入包 {{ mergedPackages.length }}</el-tag>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="合并规则"
      description="对端新增的场次 / 连戏要素 / 拍摄日 / 现场记录直接并入；只有一边改过的直接采用改动版；同一条两边都改过则两版都保留，到场记在下方裁决后才写入。现场记录一定下来，差异条目与核对报告立即重算，失效差异会标记保留。"
      class="rule-alert"
    />

    <el-descriptions :column="1" border size="small" class="device-box">
      <el-descriptions-item label="本机来源标记">
        <el-input v-model="deviceName" style="max-width: 260px" placeholder="如：外景车 / 驻地" @keyup.enter="saveDeviceName" />
        <el-button size="small" type="primary" plain @click="saveDeviceName">保存设备名</el-button>
      </el-descriptions-item>
    </el-descriptions>

    <div class="action-row">
      <el-button type="primary" :icon="FolderOpened" @click="onExport">导出场记交接包</el-button>
      <el-button :icon="Connection" @click="pasteImport">粘贴 JSON 导入</el-button>
      <el-button :icon="FolderOpened" @click="triggerFile">选择交接包文件</el-button>
      <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFilePicked" />
    </div>

    <div v-if="importFilename || importInput" class="import-preview">
      <div class="muted">待处理：{{ importFilename || '粘贴内容' }}（{{ importInput.length }} 字符）</div>
      <div>
        <el-button type="primary" size="small" @click="doImport">确认并入</el-button>
        <el-button size="small" @click="importInput = ''; importFilename = ''">清空</el-button>
      </div>
    </div>

    <!-- 待裁决：两版并排 -->
    <template v-if="pendingIssues.length > 0">
      <div class="section-title">待场记裁决（{{ pendingIssues.length }} 条，两版均已保留）</div>
      <div v-for="issue in pendingIssues" :key="issue.id" class="issue-box">
        <div class="issue-box__head">
          <el-tag type="warning" effect="dark">{{ TABLE_LABELS[issue.table] }}</el-tag>
          <strong>编号 {{ issue.recordId }}</strong>
          <span class="muted">来自「{{ issue.peerDeviceName }}」· 包导出 {{ issue.exportedAt ? issue.exportedAt.slice(0, 19).replace('T', ' ') : '—' }}</span>
        </div>
        <el-table :data="FIELD_DEFS[issue.table]" border size="small">
          <el-table-column label="字段" width="110">
            <template #default="{ row }"><strong>{{ row.label }}</strong></template>
          </el-table-column>
          <el-table-column :label="`本机版（${formatTime(issue.localUpdatedAt)}）`" min-width="200">
            <template #default="{ row }">
              <span :class="{ 'cell-diff': fieldText(issue, 'local', row) !== fieldText(issue, 'incoming', row) }">
                {{ fieldText(issue, 'local', row) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column :label="`${issue.peerDeviceName}版（${formatTime(issue.incomingUpdatedAt)}）`" min-width="200">
            <template #default="{ row }">
              <span :class="{ 'cell-diff': fieldText(issue, 'local', row) !== fieldText(issue, 'incoming', row) }">
                {{ fieldText(issue, 'incoming', row) }}
              </span>
            </template>
          </el-table-column>
        </el-table>
        <div class="issue-box__foot">
          <OriginTag :origin="originOf(issue, 'local')" />
          <el-button size="small" type="primary" @click="decide(issue, 'local')">采用本机版并写入</el-button>
          <OriginTag :origin="originOf(issue, 'incoming')" />
          <el-button size="small" type="warning" @click="decide(issue, 'incoming')">采用{{ issue.peerDeviceName }}版并写入</el-button>
        </div>
      </div>
    </template>

    <!-- 已裁决留痕 -->
    <el-collapse v-if="decidedCount > 0" class="decided-collapse">
      <el-collapse-item :title="`已裁决留痕（${decidedCount} 条）`" name="decided">
        <el-table :data="issues.filter((item) => item.state !== '待裁决')" border size="small">
          <el-table-column label="类型" width="100">
            <template #default="{ row }">{{ TABLE_LABELS[row.table as MergeIssueRow['table']] }}</template>
          </el-table-column>
          <el-table-column prop="recordId" label="记录编号" min-width="160" />
          <el-table-column label="裁决结果" width="150">
            <template #default="{ row }">
              <el-tag :type="row.state === '采用对端' ? 'warning' : 'success'" size="small">{{ row.state }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="peerDeviceName" label="对端" width="120" />
          <el-table-column label="裁决时间" min-width="160">
            <template #default="{ row }">{{ row.decidedAt ? row.decidedAt.slice(0, 19).replace('T', ' ') : '—' }}</template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <!-- 待处理 / 出错包 -->
    <el-collapse v-if="packages.length > 0" model-value="packages" class="packages-collapse">
      <el-collapse-item :title="`待处理包与出错留档（${packages.length} 个；出错保留当前库与原包，可重试）`" name="packages">
        <el-table :data="packages" border size="small" row-key="id">
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === '已并入' ? 'success' : row.status === '出错' ? 'danger' : 'info'" size="small">
                {{ row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="filename" label="文件" min-width="150" />
          <el-table-column prop="originName" label="来源" width="110" />
          <el-table-column label="导出时间" width="160">
            <template #default="{ row }">{{ row.exportedAt ? row.exportedAt.slice(0, 19).replace('T', ' ') : '—' }}</template>
          </el-table-column>
          <el-table-column prop="error" label="错误 / 并入摘要" min-width="220" show-overflow-tooltip />
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status !== '已并入'"
                link
                type="primary"
                size="small"
                :icon="RefreshLeft"
                @click="retryPackage(row)"
              >重试</el-button>
              <el-button link type="danger" size="small" :icon="Delete" @click="removePackage(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>
  </el-card>
</template>

<style scoped>
.merge-center .card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.rule-alert {
  margin: 12px 0;
}

.device-box {
  margin-bottom: 12px;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.import-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 12px;
  background: #f4f7fb;
  border: 1px dashed #b7c9db;
  border-radius: 8px;
}

.section-title {
  margin: 18px 0 10px;
  font-weight: 700;
  color: #2f5d8a;
}

.issue-box {
  margin-bottom: 14px;
  padding: 10px;
  border: 1px solid #e3b7b0;
  border-left: 4px solid #c0392b;
  border-radius: 8px;
  background: #fffdfc;
}

.issue-box__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.issue-box__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.cell-diff {
  color: #c0392b;
  font-weight: 600;
}

.decided-collapse,
.packages-collapse {
  margin-top: 14px;
}
</style>
