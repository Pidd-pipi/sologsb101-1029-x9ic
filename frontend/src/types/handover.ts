/**
 * 离线交接（按记录编号合并）相关类型定义。
 *
 * 剧组两台笔记本（外景车 / 驻地）断网期间各自修改，回来后按记录编号合并：
 * - 一边新增或改过的记录直接并入；
 * - 同一条两边都改过 → 保留两版，等场记选定后再写入；
 * - 定下来后立即重算差异条目与核对报告。
 */
import type { Scene } from './scene'
import type { Element } from './element'
import type { ShootDay } from './shootDay'
import type { Record as ContinuityRecord } from './record'
import type { Conflict } from './conflict'

/** 可交接的表（差异表由合并后重算，不直接并入） */
export type HandoverTableKey = 'scenes' | 'elements' | 'shootDays' | 'records'

export const HANDOVER_TABLE_KEYS: HandoverTableKey[] = ['scenes', 'elements', 'shootDays', 'records']

export const HANDOVER_TABLE_LABELS: Record<HandoverTableKey, string> = {
  scenes: '场次',
  elements: '连戏要素',
  shootDays: '拍摄日',
  records: '现场记录'
}

/**
 * 交接基准（上次同步时的整库快照）。
 * 三台合并时用它判断「两边是否都改过」：
 * - 记录在基准中存在且内容一致 → 该边没改过；
 * - 记录在基准中不存在或内容不一致 → 该边改过。
 */
export interface HandoverBase {
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
}

/** 交接包：导出时把当前库 + 交接基准一起打包，旧格式备份无 base 也能参与合并 */
export interface HandoverPackage {
  name: string
  schemaVersion: number
  exportedAt: string
  /** 来源标记，如「外景车A」「驻地B」 */
  source: string
  /** 交接基准（JSON 字符串）；旧格式备份可能没有 */
  base?: string
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
}

/** 字段级差异（待裁决条目展示用） */
export interface HandoverFieldDiff {
  field: string
  label: string
  local: string
  imported: string
}

/** 一条待裁决记录：同一条记录两边都改过，保留两版等场记选定 */
export interface PendingHandover {
  id: string
  table: HandoverTableKey
  recordId: string
  local: Scene | Element | ShootDay | ContinuityRecord
  imported: Scene | Element | ShootDay | ContinuityRecord
  localModified: boolean
  importedModified: boolean
  fieldDiffs: HandoverFieldDiff[]
}

/** 合并分析结果 */
export interface HandoverAnalysis {
  source: string
  exportedAt: string
  counts: {
    added: Record<HandoverTableKey, number>
    updated: Record<HandoverTableKey, number>
    kept: Record<HandoverTableKey, number>
    pending: number
    invalidated: number
    unchanged: number
  }
  pending: PendingHandover[]
}

/** 待裁决选择：recordId → 选了哪版 */
export type HandoverChoices = Record<string, 'local' | 'imported'>

/** 合并应用结果 */
export interface HandoverApplyResult {
  source: string
  counts: {
    added: Record<HandoverTableKey, number>
    updated: Record<HandoverTableKey, number>
    adjudicated: number
    invalidated: number
  }
  /** 合并后重算的差异条目数 */
  recalculatedConflicts: number
}
