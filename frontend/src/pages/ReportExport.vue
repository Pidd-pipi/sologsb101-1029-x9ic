<script setup lang="ts">
/** /report 连戏核对报告与离线交接：报告导出、按记录编号的离线交接合并与整库备份 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Refresh } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import MergeCenter from '@/components/common/MergeCenter.vue'
import {
  db,
  countAll,
  exportSnapshot,
  importSnapshot,
  resetDatabase,
  DB_NAME,
  DB_SCHEMA_VERSION,
  type ConflictRow,
  type MergeIssueRow,
  type IncomingPackageRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { buildReport, downloadJson, parseReport, riskScore, serializeReport, type ContinuityReport } from '@/utils/export'
import type { FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()

const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)
const { rows: issues } = useIdbTable<MergeIssueRow>(() => db.mergeIssues)
const { rows: packages } = useIdbTable<IncomingPackageRow>(() => db.incomingPackages)
const report = ref<ContinuityReport | null>(null)
const dbCounts = ref<Record<string, number>>({})
const filters = ref<FilterModel>({ keyword: '' })
const preview = ref('')

const liveConflicts = computed(() => conflicts.value.filter((item) => !item.invalidated))
const pendingIssueCount = computed(() => issues.value.filter((item) => item.state === '待裁决').length)
const errorPackageCount = computed(() => packages.value.filter((item) => item.status === '出错').length)

const totals = computed(() => {
  const open = liveConflicts.value.filter((item) => item.state === '待确认')
  return {
    total: liveConflicts.value.length,
    open: open.length,
    resolved: liveConflicts.value.filter((item) => item.state === '已解决').length,
    blocking: open.filter((item) => item.severity === '阻断').length,
    risk: riskScore(open),
    invalidated: conflicts.value.filter((item) => item.invalidated).length
  }
})

const rows = computed(() => {
  const list = report.value?.summary.rows ?? []
  const keyword = String(filters.value.keyword ?? '').trim().toLowerCase()
  if (!keyword) return list
  return list.filter((row) =>
    `${row.sceneNo} ${row.location} ${row.place} ${row.timeOfDay}`.toLowerCase().includes(keyword)
  )
})

async function refresh(): Promise<void> {
  report.value = await buildReport()
  dbCounts.value = await countAll()
  preview.value = serializeReport(report.value)
}

async function exportReport(): Promise<void> {
  const current = await buildReport()
  downloadJson(`连戏核对报告-${current.exportedAt.slice(0, 10)}.json`, serializeReport(current))
  ElMessage.success('连戏核对报告已下载')
}

async function exportLibrary(): Promise<void> {
  const snapshot = await exportSnapshot()
  downloadJson(`gbcontinuity-备份-${snapshot.exportedAt.slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2))
  ElMessage.success('本地库已导出（带设备身份，可直接作为交接包给对方并入）')
}

/** 整库覆盖恢复：仅用于明确要丢弃当前库、恢复某个旧备份的场景，与交接合并严格区分 */
async function restoreLibraryOverwrite(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      '整库覆盖恢复会清空当前库的全部场次 / 要素 / 拍摄日 / 记录 / 差异。离线交接请改用上方「离线交接」导入。仍要继续请粘贴备份 JSON：',
      '整库覆盖恢复（高风险）',
      { inputType: 'textarea', confirmButtonText: '我确认覆盖', type: 'warning' }
    )
    const parsed = parseReport(value)
    if (!Array.isArray((parsed as Partial<{ elements?: unknown[] }>).elements)) {
      throw new Error('缺少 elements 数组字段，不是本应用的备份文件')
    }
    await ElMessageBox.confirm('再确认一次：当前库将被该备份完全替换，此操作不可撤销。', '最终确认', {
      type: 'warning',
      confirmButtonText: '覆盖'
    })
    await importSnapshot(parsed)
    await refresh()
    ElMessage.success('备份已整库恢复')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(`恢复失败：${error.message}`)
  }
}

async function resetDemo(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空业务数据并重新灌入演示数据（保留交接基线与待处理包），是否继续？', '重置确认', {
      type: 'warning'
    })
  } catch {
    return
  }
  await resetDatabase()
  await refresh()
  ElMessage.success('已重置为演示数据')
}

function onFilterChange(next: FilterModel): void {
  filters.value = next
}

onMounted(() => {
  void refresh()
  if (typeof route.query.keyword === 'string') filters.value.keyword = route.query.keyword
})

// 交接并入 / 裁决写回 / 差异重算后，报告小结立即重算
watch([conflicts, issues, packages, () => dbCounts.value.scenes, () => dbCounts.value.records], () => {
  void refresh()
})

watch(filters, (value) => {
  void router.replace({ path: route.path, query: filtersToQuery(value) })
}, { deep: true })
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏核对报告与离线交接</h2>
        <p class="page__subtitle">
          本地库 {{ DB_NAME }}（结构版本 v{{ DB_SCHEMA_VERSION }}）· 断网两边修改后按记录编号并入，两版同改在场记裁决后写入，差异即时重算。
        </p>
      </div>
      <div>
        <el-button :icon="Download" @click="exportLibrary">导出整库备份</el-button>
        <el-button type="primary" :icon="Download" @click="exportReport">导出核对报告</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="差异条目" :value="totals.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="未解决" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="阻断级" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="待裁决记录" :value="pendingIssueCount" suffix="条" icon="Switch" tone="danger" />
      <StatBadge label="因合并失效" :value="totals.invalidated" suffix="条" icon="CircleClose" tone="info" />
      <StatBadge label="出错留档包" :value="errorPackageCount" suffix="个" icon="FolderOpened" tone="warning" />
    </div>

    <MergeCenter />

    <FilterBar
      :model-value="filters"
      keyword-placeholder="搜索场号 / 地点 / 内外景…"
      :show-reset="true"
      @update:model-value="onFilterChange"
      @reset="filters = { keyword: '' }"
    />

    <el-card v-if="report" shadow="never">
      <template #header>
        <div class="card-title">
          <span>场次核对小结</span>
          <span class="muted">
            场次 {{ report.summary.sceneCount }} · 要素 {{ report.summary.elementCount }} · 现场记录 {{ report.summary.recordCount }} ·
            因合并失效差异 {{ report.summary.invalidatedConflictCount }} 条 ·
            风险最高场次 第 {{ report.summary.riskiestSceneNo }} 场
          </span>
        </div>
      </template>
      <EmptyPanel
        v-if="rows.length === 0"
        title="没有匹配的场次"
        description="调整关键字后重试，或先到「剧本场次」页新建场次。"
        :show-create="false"
      />
      <el-table v-else :data="rows" border stripe>
        <el-table-column prop="sceneNo" label="场号" width="90" />
        <el-table-column label="内外景 / 时间" width="130">
          <template #default="{ row }">
            <ConflictTag :state="row.state" />
            <div class="muted">{{ row.place }} · {{ row.timeOfDay }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="location" label="地点" min-width="140" />
        <el-table-column prop="elementCount" label="要素数" width="90" align="right" />
        <el-table-column prop="criticalElementCount" label="关键要素" width="100" align="right" />
        <el-table-column label="未解决冲突" width="120" align="right">
          <template #default="{ row }">
            <el-tag :type="row.openConflictCount > 0 ? 'danger' : 'success'" size="small" effect="plain">
              {{ row.openConflictCount }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="resolvedConflictCount" label="已解决" width="90" align="right" />
        <el-table-column prop="shootDayCount" label="拍摄日" width="90" align="right" />
      </el-table>
    </el-card>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>本地结构版本</span><span class="muted">IndexedDB</span></div>
          </template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="库名">{{ DB_NAME }}</el-descriptions-item>
            <el-descriptions-item label="结构版本">v{{ DB_SCHEMA_VERSION }}</el-descriptions-item>
            <el-descriptions-item label="场次/要素">{{ dbCounts.scenes ?? 0 }} / {{ dbCounts.elements ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="拍摄日/记录">{{ dbCounts.shootDays ?? 0 }} / {{ dbCounts.records ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="有效/失效差异">
              {{ totals.total }} / {{ totals.invalidated }}
            </el-descriptions-item>
            <el-descriptions-item label="待裁决/留档包">
              {{ pendingIssueCount }} / {{ dbCounts.incomingPackages ?? 0 }}
            </el-descriptions-item>
            <el-descriptions-item label="报告时间" :span="2">
              {{ report?.exportedAt.slice(0, 19).replace('T', ' ') ?? '—' }}
            </el-descriptions-item>
          </el-descriptions>
          <div class="btn-row">
            <el-button type="danger" plain @click="resetDemo">重置演示数据</el-button>
            <el-button type="warning" plain @click="restoreLibraryOverwrite">整库覆盖恢复（旧备份）</el-button>
            <el-button :icon="Refresh" @click="refresh">刷新报告</el-button>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>报告 JSON 预览</span><span class="muted">可直接复制</span></div>
          </template>
          <el-input v-model="preview" type="textarea" :rows="12" readonly />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
