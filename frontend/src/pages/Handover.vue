<script setup lang="ts">
/** /handover 离线交接：按记录编号合并两台机器的离线修改，待裁决条目场记选定后写入 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Upload, RefreshLeft, Check } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useHandoverStore } from '@/stores/handoverStore'
import { exportHandoverPackage } from '@/utils/db'
import { downloadJson } from '@/utils/export'
import { HANDOVER_TABLE_KEYS, HANDOVER_TABLE_LABELS, type HandoverTableKey } from '@/types/handover'
import { fieldDiffsDescription } from '@/utils/merge'

const store = useHandoverStore()

const packageText = ref('')
const exportSource = ref('外景车A')
const fileInput = ref<HTMLInputElement | null>(null)

const analyzing = computed(() => store.status === 'analyzing')
const ready = computed(() => store.status === 'ready')
const merging = computed(() => store.status === 'merging')
const done = computed(() => store.status === 'done')
const hasError = computed(() => store.status === 'error' && !!store.error)

const pendingList = computed(() => store.analysis?.pending ?? [])
const pendingCount = computed(() => pendingList.value.length)

/** 导出当前整库为交接包 */
async function exportPackage(): Promise<void> {
  if (!exportSource.value.trim()) {
    ElMessage.warning('请填写来源标记，如「外景车A」')
    return
  }
  const pkg = await exportHandoverPackage(exportSource.value.trim())
  downloadJson(`gbcontinuity-交接包-${pkg.source}-${pkg.exportedAt.slice(0, 10)}.json`, JSON.stringify(pkg, null, 2))
  ElMessage.success(`已导出来源为「${pkg.source}」的交接包`)
}

/** 触发文件选择 */
function triggerFileInput(): void {
  fileInput.value?.click()
}

/** 读取上传的 JSON 文件 */
async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  packageText.value = text
  // 重置 input 以便重复选择同一文件
  input.value = ''
  ElMessage.info(`已读取文件 ${file.name}，点击「分析交接包」继续`)
}

/** 分析交接包 */
async function analyzePackage(): Promise<void> {
  if (!packageText.value.trim()) {
    ElMessage.warning('请粘贴交接包 JSON 或选择文件')
    return
  }
  await store.analyze(packageText.value)
  if (store.status === 'ready') {
    ElMessage.success('交接包分析完成，请确认待裁决条目')
  }
}

/** 确认并入 */
async function confirmMerge(): Promise<void> {
  await store.confirmMerge()
  if (store.status === 'done') {
    ElMessage.success('交接合并完成，差异条目与核对报告已重算')
  }
}

/** 重置交接 */
function resetHandover(): void {
  store.reset()
  packageText.value = ''
}

/** 某条待裁决的字段差异描述 */
function diffDescription(pendingId: string): string {
  const pending = pendingList.value.find((item) => item.id === pendingId)
  return pending ? fieldDiffsDescription(pending.fieldDiffs) : ''
}

/** 某条待裁决选了哪版 */
function choiceOf(pendingId: string): 'local' | 'imported' {
  return store.choices[pendingId] ?? 'imported'
}

/** 表名标签 */
function tableLabel(table: HandoverTableKey): string {
  return HANDOVER_TABLE_LABELS[table]
}
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">离线交接</h2>
        <p class="page__subtitle">
          两台笔记本断网期间各自修改，回来后按记录编号合并：一边改过的直接并入，同一条两边都改过则保留两版等场记选定。
        </p>
      </div>
    </div>

    <!-- 导出交接包 -->
    <el-card shadow="never" class="handover-card">
      <template #header>
        <div class="card-title">
          <span>① 导出本机交接包</span>
          <span class="muted">断网前 / 回来后，把本机当前整库 + 交接基准打包带走</span>
        </div>
      </template>
      <div class="export-row">
        <el-input v-model="exportSource" placeholder="来源标记，如：外景车A" class="source-input" />
        <el-button type="primary" :icon="Download" @click="exportPackage">导出交接包</el-button>
      </div>
      <p class="muted export-hint">
        交接包内含本机当前数据与上次同步基准，对方导入时据此判断「谁改过」。旧备份（无基准）也能参与合并，只是所有差异都会进入待裁决。
      </p>
    </el-card>

    <!-- 导入交接包 -->
    <el-card shadow="never" class="handover-card">
      <template #header>
        <div class="card-title">
          <span>② 导入对方交接包</span>
          <span class="muted">粘贴 JSON 或选择文件，分析后确认并入</span>
        </div>
      </template>

      <div v-if="!store.pendingPackage" class="import-area">
        <el-input
          v-model="packageText"
          type="textarea"
          :rows="8"
          placeholder="粘贴对方交接包 JSON 内容…"
        />
        <div class="import-actions">
          <el-button :icon="Upload" @click="triggerFileInput">选择 JSON 文件</el-button>
          <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
          <el-button type="primary" :loading="analyzing" @click="analyzePackage">分析交接包</el-button>
        </div>
      </div>

      <div v-else class="import-area">
        <el-descriptions :column="3" border size="small" class="pkg-desc">
          <el-descriptions-item label="来源">{{ store.pendingPackage.source }}</el-descriptions-item>
          <el-descriptions-item label="导出时间">{{ store.pendingPackage.exportedAt.slice(0, 19).replace('T', ' ') }}</el-descriptions-item>
          <el-descriptions-item label="结构版本">v{{ store.pendingPackage.schemaVersion }}</el-descriptions-item>
        </el-descriptions>
        <div class="import-actions">
          <el-button :icon="RefreshLeft" @click="resetHandover">重新导入</el-button>
        </div>
      </div>

      <el-alert
        v-if="hasError"
        :title="`合并失败：${store.error}`"
        type="error"
        show-icon
        class="error-alert"
      >
        <template #default>
          <div>合并失败：{{ store.error }}</div>
          <div class="muted">当前库与待处理包均已保留，可修正后重试或重新导入。</div>
        </template>
      </el-alert>
    </el-card>

    <!-- 分析结果 -->
    <template v-if="ready && store.analysis">
      <div class="badge-row">
        <StatBadge label="来源" :value="store.analysis.source" icon="Files" tone="primary" />
        <StatBadge label="直接新增" :value="Object.values(store.analysis.counts.added).reduce((a, b) => a + b, 0)" suffix="条" icon="Grid" tone="success" />
        <StatBadge label="直接更新" :value="Object.values(store.analysis.counts.updated).reduce((a, b) => a + b, 0)" suffix="条" icon="DataLine" tone="info" />
        <StatBadge label="待裁决" :value="pendingCount" suffix="条" icon="WarningFilled" tone="warning" />
        <StatBadge label="失效条目" :value="store.analysis.counts.invalidated" suffix="条" icon="CircleClose" tone="danger" />
        <StatBadge label="无变化" :value="store.analysis.counts.unchanged" suffix="条" icon="Check" tone="default" />
      </div>

      <!-- 待裁决明细 -->
      <el-card shadow="never" class="handover-card">
        <template #header>
          <div class="card-title">
            <span>③ 待裁决条目（{{ pendingCount }}）</span>
            <span class="muted">同一条两边都改过，保留两版等场记选定</span>
          </div>
        </template>

        <EmptyPanel
          v-if="pendingCount === 0"
          title="没有待裁决条目"
          description="所有差异都可直接并入，点击下方「确认并入」完成交接。"
          :show-create="false"
        />

        <div v-else class="pending-actions">
          <el-button size="small" @click="store.setAllChoices('local')">全选本地版</el-button>
          <el-button size="small" @click="store.setAllChoices('imported')">全选导入版</el-button>
        </div>

        <el-table v-if="pendingCount > 0" :data="pendingList" border stripe row-key="id">
          <el-table-column label="表 / 编号" width="140">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ tableLabel(row.table) }}</el-tag>
              <div class="muted record-id">{{ row.recordId }}</div>
            </template>
          </el-table-column>
          <el-table-column label="字段差异" min-width="260">
            <template #default="{ row }">
              <div class="diff-desc">{{ diffDescription(row.id) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="场记选定" width="200" align="center">
            <template #default="{ row }">
              <el-radio-group
                :model-value="choiceOf(row.id)"
                @change="(val: string) => store.setChoice(row.id, val as 'local' | 'imported')"
              >
                <el-radio value="local">本地版</el-radio>
                <el-radio value="imported">导入版</el-radio>
              </el-radio-group>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <div class="confirm-row">
        <el-button type="primary" size="large" :icon="Check" :loading="merging" @click="confirmMerge">
          确认并入（{{ pendingCount }} 条待裁决已选好）
        </el-button>
      </div>
    </template>

    <!-- 合并完成 -->
    <el-card v-if="done && store.applyResult" shadow="never" class="handover-card">
      <template #header>
        <div class="card-title">
          <span>✅ 交接完成</span>
          <span class="muted">差异条目与核对报告已立即重算</span>
        </div>
      </template>
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="来源">{{ store.applyResult.source }}</el-descriptions-item>
        <el-descriptions-item label="直接新增">
          {{ HANDOVER_TABLE_KEYS.map((t) => `${HANDOVER_TABLE_LABELS[t]} ${store.applyResult!.counts.added[t]}`).join(' · ') }}
        </el-descriptions-item>
        <el-descriptions-item label="直接更新">
          {{ HANDOVER_TABLE_KEYS.map((t) => `${HANDOVER_TABLE_LABELS[t]} ${store.applyResult!.counts.updated[t]}`).join(' · ') }}
        </el-descriptions-item>
        <el-descriptions-item label="待裁决已写入">{{ store.applyResult.counts.adjudicated }} 条</el-descriptions-item>
        <el-descriptions-item label="失效条目已清理">{{ store.applyResult.counts.invalidated }} 条</el-descriptions-item>
        <el-descriptions-item label="重算后差异条目">{{ store.applyResult.recalculatedConflicts }} 条</el-descriptions-item>
      </el-descriptions>
      <div class="confirm-row">
        <el-button type="primary" @click="resetHandover">继续下一次交接</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.handover-card {
  margin-bottom: 16px;
}

.export-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.source-input {
  max-width: 260px;
}

.export-hint {
  margin-top: 8px;
  font-size: 12px;
}

.import-area {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.pkg-desc {
  margin-bottom: 4px;
}

.error-alert {
  margin-top: 12px;
}

.pending-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.record-id {
  font-size: 11px;
  word-break: break-all;
}

.diff-desc {
  font-size: 13px;
  line-height: 1.6;
}

.confirm-row {
  display: flex;
  justify-content: center;
  margin: 16px 0;
}
</style>
