/**
 * 离线交接（按记录编号合并）核心逻辑。
 *
 * 剧组两台笔记本（外景车 / 驻地）断网期间各自修改，回来后按记录编号合并：
 * - 一边新增或改过的记录直接并入；
 * - 同一条两边都改过 → 保留两版，等场记选定后再写入；
 * - 定下来后立即重算差异条目与核对报告。
 *
 * 三台合并用「交接基准」判断两边是否都改过：
 * - 记录在基准中存在且内容一致 → 该边没改过；
 * - 记录在基准中不存在或内容不一致 → 该边改过。
 */
import type { Scene } from '@/types/scene'
import type { Element } from '@/types/element'
import type { ShootDay } from '@/types/shootDay'
import type { Record as ContinuityRecord } from '@/types/record'
import type { Conflict } from '@/types/conflict'
import type {
  HandoverApplyResult,
  HandoverAnalysis,
  HandoverBase,
  HandoverFieldDiff,
  HandoverPackage,
  HandoverTableKey,
  PendingHandover
} from '@/types/handover'
import { HANDOVER_TABLE_KEYS, HANDOVER_TABLE_LABELS } from '@/types/handover'
import {
  db,
  ROW_REVISION,
  buildBaseFromCurrent,
  loadBase,
  saveBase,
  type ConflictRow,
  type ElementRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow
} from './db'
import { generateDiffCandidates } from './diff'
import { createId } from './uuid'

/** 各表字段标签（待裁决展示用） */
const FIELD_LABELS: Record<HandoverTableKey, Record<string, string>> = {
  scenes: {
    sceneNo: '场号',
    place: '内外景',
    timeOfDay: '时间',
    location: '地点',
    excerpt: '剧本节选',
    shootOrder: '拍摄顺序',
    state: '拍摄状态'
  },
  elements: {
    category: '类别',
    name: '名称',
    initialState: '初始状态',
    owner: '责任人',
    critical: '关键要素',
    sceneId: '所属场次'
  },
  shootDays: {
    date: '日期',
    director: '导演',
    scripty: '场记',
    weatherNote: '现场备注',
    sceneIds: '当日场次'
  },
  records: {
    takeNo: '镜次',
    currentState: '当前状态',
    photoNote: '照片说明',
    recordedBy: '记录人',
    shootDayId: '拍摄日',
    elementId: '连戏要素',
    sceneId: '所属场次'
  }
}

/** 剥掉元数据字段，只比较业务内容 */
function contentKey(row: unknown): string {
  if (row === null || typeof row !== 'object') return String(row)
  const copy = { ...(row as Record<string, unknown>) }
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  delete copy.source
  return JSON.stringify(copy)
}

/** 两条记录业务内容是否一致 */
function contentEqual(a: unknown, b: unknown): boolean {
  return contentKey(a) === contentKey(b)
}

/** 把字段值转成可展示文本 */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

/** 通用字段级比对（用于场次 / 要素 / 拍摄日） */
function diffGenericFields(
  table: HandoverTableKey,
  local: Record<string, unknown>,
  imported: Record<string, unknown>
): HandoverFieldDiff[] {
  const labels = FIELD_LABELS[table]
  const fields = Object.keys(labels)
  const diffs: HandoverFieldDiff[] = []
  fields.forEach((field) => {
    const lv = displayValue(local[field])
    const iv = displayValue(imported[field])
    if (lv !== iv) {
      diffs.push({ field, label: labels[field], local: lv, imported: iv })
    }
  })
  return diffs
}

/** 现场记录的字段级比对（复用 diff 模块的归一化逻辑） */
function diffRecordFields(local: ContinuityRecord, imported: ContinuityRecord): HandoverFieldDiff[] {
  const diffs: HandoverFieldDiff[] = []
  const push = (field: string, label: string, lv: string, iv: string, normalize: boolean): void => {
    const a = normalize ? lv.trim() : lv.trim()
    const b = normalize ? iv.trim() : iv.trim()
    if (a !== b && (a.length > 0 || b.length > 0)) {
      diffs.push({ field, label, local: lv, imported: iv })
    }
  }
  push('takeNo', '镜次', local.takeNo, imported.takeNo, false)
  push('currentState', '当前状态', local.currentState, imported.currentState, false)
  push('photoNote', '照片说明', local.photoNote, imported.photoNote, false)
  push('recordedBy', '记录人', local.recordedBy, imported.recordedBy, false)
  return diffs
}

/** 按表名取本地行 */
async function loadLocalRows(table: HandoverTableKey): Promise<Array<Scene | Element | ShootDay | ContinuityRecord>> {
  switch (table) {
    case 'scenes':
      return db.scenes.toArray()
    case 'elements':
      return db.elements.toArray()
    case 'shootDays':
      return db.shootDays.toArray()
    case 'records':
      return db.records.toArray()
  }
}

/** 按表名取交接包行 */
function packageRows(pkg: HandoverPackage, table: HandoverTableKey): Array<Scene | Element | ShootDay | ContinuityRecord> {
  return pkg[table]
}

/** 按表名取基准行 */
function baseRows(base: HandoverBase | null, table: HandoverTableKey): Array<Scene | Element | ShootDay | ContinuityRecord> {
  if (!base) return []
  return base[table]
}

/** 解析交接包 JSON 文本（兼容旧格式备份），失败抛出可读错误 */
export function parseHandoverPackage(text: string): HandoverPackage {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('交接包根节点必须是对象')
  }
  const candidate = parsed as Partial<HandoverPackage>
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段')
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段')
  if (typeof candidate.exportedAt !== 'string') throw new Error('缺少 exportedAt 字段')
  if (!Array.isArray(candidate.scenes)) throw new Error('scenes 必须是数组')
  if (!Array.isArray(candidate.elements)) throw new Error('elements 必须是数组')
  if (!Array.isArray(candidate.shootDays)) throw new Error('shootDays 必须是数组')
  if (!Array.isArray(candidate.records)) throw new Error('records 必须是数组')
  if (!Array.isArray(candidate.conflicts)) throw new Error('conflicts 必须是数组')

  // 旧格式备份没有 source / base，补默认值
  const pkg: HandoverPackage = {
    name: candidate.name,
    schemaVersion: candidate.schemaVersion,
    exportedAt: candidate.exportedAt,
    source: typeof candidate.source === 'string' && candidate.source.length > 0 ? candidate.source : '旧备份',
    scenes: candidate.scenes,
    elements: candidate.elements,
    shootDays: candidate.shootDays,
    records: candidate.records,
    conflicts: candidate.conflicts
  }
  if (typeof candidate.base === 'string' && candidate.base.length > 0) {
    try {
      JSON.parse(candidate.base)
      pkg.base = candidate.base
    } catch {
      // base 损坏时忽略，按无基准处理
    }
  }
  return pkg
}

/** 分析交接包：哪些直接并入、哪些待裁决、哪些失效 */
export async function analyzeHandover(pkg: HandoverPackage): Promise<HandoverAnalysis> {
  const [localBase, localRowsAll] = await Promise.all([loadBase(), loadAllLocal()])

  const counts: HandoverAnalysis['counts'] = {
    added: { scenes: 0, elements: 0, shootDays: 0, records: 0 },
    updated: { scenes: 0, elements: 0, shootDays: 0, records: 0 },
    kept: { scenes: 0, elements: 0, shootDays: 0, records: 0 },
    pending: 0,
    invalidated: 0,
    unchanged: 0
  }
  const pending: PendingHandover[] = []

  for (const table of HANDOVER_TABLE_KEYS) {
    const localRows = localRowsAll[table]
    const baseRowsList = baseRows(localBase, table)
    const importedRows = packageRows(pkg, table)

    const localMap = new Map<string, Scene | Element | ShootDay | ContinuityRecord>()
    localRows.forEach((row) => localMap.set(row.id, row))
    const baseMap = new Map<string, Scene | Element | ShootDay | ContinuityRecord>()
    baseRowsList.forEach((row) => baseMap.set(row.id, row))

    for (const imported of importedRows) {
      const local = localMap.get(imported.id)
      if (!local) {
        // 对方新增 → 直接并入
        counts.added[table] += 1
        continue
      }
      if (contentEqual(local, imported)) {
        // 内容一致 → 无动作
        counts.unchanged += 1
        continue
      }
      // 内容有差异，判断谁改过
      const base = baseMap.get(imported.id)
      const localModified = !base || !contentEqual(local, base)
      const importedModified = !base || !contentEqual(imported, base)

      if (localModified && importedModified) {
        // 两边都改过 → 待裁决
        const fieldDiffs =
          table === 'records'
            ? diffRecordFields(local as ContinuityRecord, imported as ContinuityRecord)
            : diffGenericFields(table, local as unknown as Record<string, unknown>, imported as unknown as Record<string, unknown>)
        pending.push({
          id: `pending-${table}-${imported.id}`,
          table,
          recordId: imported.id,
          local,
          imported,
          localModified,
          importedModified,
          fieldDiffs
        })
        counts.pending += 1
      } else if (importedModified) {
        // 仅对方改过 → 直接并入
        counts.updated[table] += 1
      } else {
        // 仅本地改过 → 保留本地
        counts.kept[table] += 1
      }
    }
  }

  // 失效条目：引用了已删除记录 / 要素的差异（本地 + 对方包都算）
  const recordIds = new Set(localRowsAll.records.map((row) => row.id))
  const elementIds = new Set(localRowsAll.elements.map((row) => row.id))
  const importedRecordIds = new Set(pkg.records.map((row) => row.id))
  const importedElementIds = new Set(pkg.elements.map((row) => row.id))
  // 合并后生效的记录 / 要素 id 集合
  const mergedRecordIds = new Set([...recordIds, ...importedRecordIds])
  const mergedElementIds = new Set([...elementIds, ...importedElementIds])
  const isInvalid = (conflict: Conflict): boolean =>
    !mergedRecordIds.has(conflict.recordIdA) ||
    !mergedRecordIds.has(conflict.recordIdB) ||
    !mergedElementIds.has(conflict.elementId)
  // 对方包带来的失效差异
  for (const conflict of pkg.conflicts) {
    if (isInvalid(conflict)) counts.invalidated += 1
  }
  // 本地已有的失效差异（合并后重算时会被清理）
  const localConflicts = await db.conflicts.toArray()
  for (const conflict of localConflicts) {
    if (isInvalid(conflict)) counts.invalidated += 1
  }

  return {
    source: pkg.source,
    exportedAt: pkg.exportedAt,
    counts,
    pending
  }
}

/** 加载全部本地行 */
async function loadAllLocal(): Promise<Record<HandoverTableKey, Array<Scene | Element | ShootDay | ContinuityRecord>>> {
  const [scenes, elements, shootDays, records] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray()
  ])
  return { scenes, elements, shootDays, records }
}

/** 把行写入对应表（保留来源标记） */
async function putRow(table: HandoverTableKey, row: Scene | Element | ShootDay | ContinuityRecord, source: string): Promise<void> {
  const now = Date.now()
  const stamped = { ...row, source, revision: ROW_REVISION, updatedAt: now }
  // createdAt 保留本地已有的，否则用导入包的
  const existing = await getRow(table, row.id)
  const createdAt = existing ? (existing as { createdAt?: number }).createdAt ?? now : now
  const finalRow = { ...stamped, createdAt } as SceneRow | ElementRow | ShootDayRow | RecordRow
  switch (table) {
    case 'scenes':
      await db.scenes.put(finalRow as SceneRow)
      break
    case 'elements':
      await db.elements.put(finalRow as ElementRow)
      break
    case 'shootDays':
      await db.shootDays.put(finalRow as ShootDayRow)
      break
    case 'records':
      await db.records.put(finalRow as RecordRow)
      break
  }
}

/** 按表名与 id 取本地行 */
async function getRow(table: HandoverTableKey, id: string): Promise<Scene | Element | ShootDay | ContinuityRecord | undefined> {
  switch (table) {
    case 'scenes':
      return db.scenes.get(id)
    case 'elements':
      return db.elements.get(id)
    case 'shootDays':
      return db.shootDays.get(id)
    case 'records':
      return db.records.get(id)
  }
}

/**
 * 应用交接合并：
 * - 直接并入新增 / 仅对方改过的记录；
 * - 按场记选择写入待裁决记录；
 * - 更新交接基准为合并后的状态；
 * - 重算差异条目。
 */
export async function applyHandover(
  pkg: HandoverPackage,
  analysis: HandoverAnalysis,
  choices: Record<string, 'local' | 'imported'>
): Promise<HandoverApplyResult> {
  const counts: HandoverApplyResult['counts'] = {
    added: { scenes: 0, elements: 0, shootDays: 0, records: 0 },
    updated: { scenes: 0, elements: 0, shootDays: 0, records: 0 },
    adjudicated: 0,
    invalidated: 0
  }

  await db.transaction('rw', [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.syncState], async () => {
    // 1. 写入新增 / 仅对方改过的记录
    for (const table of HANDOVER_TABLE_KEYS) {
      const localMap = new Map<string, Scene | Element | ShootDay | ContinuityRecord>()
      ;(await loadLocalRows(table)).forEach((row) => localMap.set(row.id, row))
      for (const imported of pkg[table]) {
        const local = localMap.get(imported.id)
        if (!local) {
          await putRow(table, imported, pkg.source)
          counts.added[table] += 1
        } else if (!contentEqual(local, imported)) {
          // 有差异：判断是否待裁决
          const pending = analysis.pending.find((item) => item.table === table && item.recordId === imported.id)
          if (!pending) {
            // 非待裁决 → 仅对方改过，直接并入
            await putRow(table, imported, pkg.source)
            counts.updated[table] += 1
          }
        }
      }
    }

    // 2. 写入待裁决记录（按场记选择）
    for (const pending of analysis.pending) {
      const choice = choices[pending.id] ?? 'imported'
      const chosen = choice === 'local' ? pending.local : pending.imported
      const source = choice === 'local' ? '本地' : pkg.source
      await putRow(pending.table, chosen, source)
      counts.adjudicated += 1
    }

    // 3. 更新交接基准为合并后的状态
    const newBase = await buildBaseFromCurrent()
    await saveBase(newBase)
  })

  // 4. 重算差异条目（事务外执行，避免长事务）
  const invalidated = await recalculateConflicts()
  counts.invalidated = invalidated

  // 5. 统计重算后的差异条目数
  const recalculatedConflicts = await db.conflicts.count()

  return {
    source: pkg.source,
    counts,
    recalculatedConflicts
  }
}

/**
 * 合并后重算差异条目：
 * - 引用已删除记录 / 要素的差异 → 删除（失效条目）；
 * - 同一对记录的差异已存在 → 保留处理状态，更新描述与严重程度；
 * - 新产生的差异 → 新建待确认条目。
 * 返回失效条目数。
 */
export async function recalculateConflicts(): Promise<number> {
  const [records, elements, shootDays, existingConflicts] = await Promise.all([
    db.records.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.conflicts.toArray()
  ])

  const recordIds = new Set(records.map((row) => row.id))
  const elementIds = new Set(elements.map((row) => row.id))

  // 1. 删除失效条目（引用已删除记录 / 要素）
  let invalidated = 0
  const validConflicts: ConflictRow[] = []
  for (const conflict of existingConflicts) {
    if (!recordIds.has(conflict.recordIdA) || !recordIds.has(conflict.recordIdB) || !elementIds.has(conflict.elementId)) {
      await db.conflicts.delete(conflict.id)
      invalidated += 1
    } else {
      validConflicts.push(conflict)
    }
  }

  // 2. 生成差异候选
  const candidates = generateDiffCandidates(records, elements, shootDays)

  // 3. 建立现有差异的索引（同要素 + 同记录对）
  const conflictMap = new Map<string, ConflictRow>()
  validConflicts.forEach((conflict) => {
    const key = `${conflict.elementId}|${conflict.recordIdA}|${conflict.recordIdB}`
    conflictMap.set(key, conflict)
  })

  // 4. 新建或更新差异条目
  const now = Date.now()
  for (const candidate of candidates) {
    const key = `${candidate.elementId}|${candidate.a.id}|${candidate.b.id}`
    const existing = conflictMap.get(key)
    if (existing) {
      // 保留处理状态，更新描述与严重程度
      await db.conflicts.update(existing.id, {
        diffDesc: candidate.desc,
        severity: candidate.severity,
        updatedAt: now
      } as never)
    } else {
      await db.conflicts.put({
        id: createId('conflict'),
        elementId: candidate.elementId,
        recordIdA: candidate.a.id,
        recordIdB: candidate.b.id,
        diffDesc: candidate.desc,
        severity: candidate.severity,
        state: '待确认',
        resolvedNote: '',
        resolvedAt: '',
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      } as ConflictRow)
    }
  }

  return invalidated
}

/** 表名 → 中文标签 */
export function tableLabel(table: HandoverTableKey): string {
  return HANDOVER_TABLE_LABELS[table]
}

/** 把差异条目转成可读描述 */
export function fieldDiffsDescription(diffs: HandoverFieldDiff[]): string {
  if (diffs.length === 0) return '无差异'
  return diffs.map((item) => `${item.label}：「${item.local || '空'}」→「${item.imported || '空'}」`).join('；')
}
