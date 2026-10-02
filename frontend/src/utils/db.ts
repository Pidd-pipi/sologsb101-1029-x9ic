/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，当前结构版本 version(2)
 * - 业务表：场次 / 连戏要素 / 拍摄日 / 现场记录 / 连戏差异，每行带 revision / createdAt / updatedAt / origin
 * - 离线交接表：syncState（对端基线）/ mergeIssues（待裁决两版）/ incomingPackages（待处理包与出错留档）
 * - 首次打开自动播种互相引用的演示数据（含未解决冲突），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'
import { ORIGIN_SEED, getDevice, getDeviceName } from './device'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned
export type ShootDayRow = ShootDay & Revisioned
export type RecordRow = ContinuityRecord & Revisioned
export type ConflictRow = Conflict & Revisioned

/* ----------------------- 离线交接专用结构 ----------------------- */

/** 交接包四类业务表的行集合（不含差异：差异由本机按记录重算） */
export interface HandoffEntitySet {
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
}

/** 上次与某个对端交接时见过的对端行（三方合并的 base） */
export interface SyncStateRow extends HandoffEntitySet {
  /** 对端设备 ID */
  peerDeviceId: string
  /** 对端设备名（最近一次交接所见） */
  peerDeviceName: string
  updatedAt: number
}

export type MergeTableKey = 'scenes' | 'elements' | 'shootDays' | 'records'

/** 待裁决记录：同一条两边都改过，两版都保留到场记选定 */
export interface MergeIssueRow extends Revisioned {
  id: string
  /** 归属业务表 */
  table: MergeTableKey
  /** 业务记录编号 */
  recordId: string
  /** 交接包 ID */
  packageId: string
  /** 来源对端设备名 */
  peerDeviceName: string
  /** 本机版本（裁决时的当前库行） */
  local: Record<string, unknown>
  /** 对端版本（交接包行） */
  incoming: Record<string, unknown>
  /** 两版各自的最后更新时间 */
  localUpdatedAt: number
  incomingUpdatedAt: number
  /** 包导出时间（ISO） */
  exportedAt: string
  state: '待裁决' | '采用本机' | '采用对端'
  decidedAt: string
}

export type IncomingPackageStatus = '待处理' | '已并入' | '出错'

/** 待处理 / 出错留档的交接包：导入出错也保留，便于重试 */
export interface IncomingPackageRow extends Revisioned {
  id: string
  /** 原文件名（粘贴导入为空） */
  filename: string
  status: IncomingPackageStatus
  /** 对端设备名（解析成功时） */
  originName: string
  /** 包导出时间 ISO */
  exportedAt: string
  /** 包整体 JSON 文本 */
  payload: string
  /** 最近一次错误信息（出错留档时） */
  error: string
  /** 本次并入结果摘要（已并入时） */
  resultSummary: string
}

/**
 * 深度剥掉 Vue 响应式代理（Proxy），得到可被 IndexedDB 结构化克隆的普通对象。
 * 页面里 `v-model` 绑定的数组字段（如 `ShootDay.sceneIds`）是 Vue 的 Proxy 数组，
 * 直接交给 Dexie 会抛 `DataCloneError: [object Object] could not be cloned`，
 * 表现为“保存按钮点了没反应、列表不增加、刷新后丢失”。所有写库入口都必须先过这一层。
 */
export function toPlainRow<T>(value: T): T {
  const raw = toRaw(value) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlainRow(item)) as unknown as T
  if (raw !== null && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    // 只深拷贝普通对象/数组，Date、Map 等结构化克隆本身支持的对象原样返回
    if (proto === Object.prototype || proto === null) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(raw)) plain[key] = toPlainRow(item)
      return plain as T
    }
  }
  return raw as T
}

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  syncState!: Table<SyncStateRow, string>
  mergeIssues!: Table<MergeIssueRow, string>
  incomingPackages!: Table<IncomingPackageRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
      elements: 'id, sceneId, category, name, owner, critical, updatedAt',
      shootDays: 'id, date, director, scripty, updatedAt',
      records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
      conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
    })

    // version(2)：业务行加 origin 索引；差异加失效标记；新增交接三表
    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, origin, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, origin, updatedAt',
        shootDays: 'id, date, director, scripty, origin, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, origin, updatedAt',
        // 注意：invalidated 是布尔值，IndexedDB 不接受布尔键，故不进索引（查询走 filter）
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt',
        syncState: 'peerDeviceId, peerDeviceName, updatedAt',
        mergeIssues: 'id, table, recordId, packageId, state, updatedAt',
        incomingPackages: 'id, status, originName, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐修订号 / 时间戳 / 来源；播种数据按固定 ID 识别
        const seedIds: Record<string, Set<string>> = {
          scenes: new Set(['sc-001', 'sc-002', 'sc-003']),
          elements: new Set(['el-001', 'el-002', 'el-003', 'el-004', 'el-005', 'el-006']),
          shootDays: new Set(['sd-001', 'sd-002', 'sd-003']),
          records: new Set(Array.from({ length: 9 }, (_, i) => `rec-00${i + 1}`))
        }
        const deviceName = getDeviceName()
        const tableNames = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']
        for (const name of tableNames) {
          const seeds = seedIds[name]
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              if (name !== 'conflicts') {
                if (typeof row.origin !== 'string' || !row.origin) {
                  row.origin = seeds?.has(String(row.id)) ? ORIGIN_SEED : deviceName
                }
              } else {
                if (typeof row.invalidated !== 'boolean') row.invalidated = false
                if (typeof row.invalidReason !== 'string') row.invalidReason = ''
              }
            })
        }
      })
  }
}

export const db = new GbContinuityDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.scenes.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenes(): Promise<SceneRow[]> {
  const rows = await db.scenes.toArray()
  return rows.sort((a, b) => a.shootOrder - b.shootOrder)
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(toPlainRow(withOrigin(row)))
}

export async function updateScene(id: string, patch: Partial<Scene>): Promise<void> {
  await db.scenes.update(id, toPlainRow({ ...patch, origin: getDeviceName(), updatedAt: Date.now() }) as never)
}

/** 拖拽调序后按新顺序批量写回 shootOrder（从 1 开始自动重编号） */
export async function reorderScenes(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.scenes, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.scenes.update(orderedIds[index], { shootOrder: index + 1, origin: getDeviceName(), updatedAt: Date.now() } as never)
    }
  })
}

/** 下一个可用拍摄顺序号 */
export async function nextShootOrder(): Promise<number> {
  const rows = await db.scenes.toArray()
  return rows.reduce((max, row) => Math.max(max, row.shootOrder), 0) + 1
}

/** 删除场次：级联删除其下要素、现场记录与差异 */
export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.records, db.conflicts, db.mergeIssues], async () => {
    const elements = await db.elements.where('sceneId').equals(id).toArray()
    const elementIds = elements.map((item) => item.id)
    const records = await db.records.where('sceneId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (elementIds.length > 0) {
      await db.conflicts.where('elementId').anyOf(elementIds).delete()
    }
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('sceneId').equals(id).delete()
    await db.elements.where('sceneId').equals(id).delete()
    await db.shootDays.toCollection().modify((day) => {
      if (day.sceneIds.includes(id)) {
        day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
        day.updatedAt = Date.now()
      }
    })
    await db.scenes.delete(id)
    // 相关待裁决条目随业务行一起消失
    await db.mergeIssues.filter((item) => item.table === 'scenes' && item.recordId === id).delete()
    await db.mergeIssues.filter((item) => item.table === 'elements' && elementIds.includes(item.recordId)).delete()
    await db.mergeIssues.filter((item) => item.table === 'records' && recordIds.includes(item.recordId)).delete()
  })
}

/* ---------------------------- 连戏要素 ---------------------------- */

export async function listElements(): Promise<ElementRow[]> {
  const rows = await db.elements.toArray()
  return rows.sort((a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putElement(row: ElementRow): Promise<void> {
  await db.elements.put(toPlainRow(withOrigin(row)))
}

export async function updateElement(id: string, patch: Partial<Element>): Promise<void> {
  await db.elements.update(id, toPlainRow({ ...patch, origin: getDeviceName(), updatedAt: Date.now() }) as never)
}

export async function removeElement(id: string): Promise<void> {
  await db.transaction('rw', [db.elements, db.records, db.conflicts, db.mergeIssues], async () => {
    const records = await db.records.where('elementId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    await db.conflicts.where('elementId').equals(id).delete()
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('elementId').equals(id).delete()
    await db.elements.delete(id)
    await db.mergeIssues.filter((item) => item.table === 'elements' && item.recordId === id).delete()
    await db.mergeIssues.filter((item) => item.table === 'records' && recordIds.includes(item.recordId)).delete()
  })
}

/* ------------------------------ 拍摄日 ------------------------------ */

export async function listShootDays(): Promise<ShootDayRow[]> {
  const rows = await db.shootDays.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putShootDay(row: ShootDayRow): Promise<void> {
  await db.shootDays.put(toPlainRow(withOrigin(row)))
}

export async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
  await db.shootDays.update(id, toPlainRow({ ...patch, origin: getDeviceName(), updatedAt: Date.now() }) as never)
}

export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts, db.mergeIssues], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('shootDayId').equals(id).delete()
    await db.shootDays.delete(id)
    await db.mergeIssues.filter((item) => item.table === 'shootDays' && item.recordId === id).delete()
    await db.mergeIssues.filter((item) => item.table === 'records' && recordIds.includes(item.recordId)).delete()
  })
}

/* ---------------------------- 现场记录 ---------------------------- */

export async function listRecords(): Promise<RecordRow[]> {
  const rows = await db.records.toArray()
  return rows.sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
}

export async function putRecord(row: RecordRow): Promise<void> {
  await db.records.put(toPlainRow(withOrigin(row)))
}

export async function updateRecord(id: string, patch: Partial<ContinuityRecord>): Promise<void> {
  await db.records.update(id, toPlainRow({ ...patch, origin: getDeviceName(), updatedAt: Date.now() }) as never)
}

export async function removeRecord(id: string): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts, db.mergeIssues], async () => {
    await db.conflicts.filter((item) => item.recordIdA === id || item.recordIdB === id).delete()
    await db.records.delete(id)
    await db.mergeIssues.filter((item) => item.table === 'records' && item.recordId === id).delete()
  })
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(withInvalidFlag(row)))
}

/** 批量写入比对生成的差异条目（已存在的同一对记录不重复生成；失效条目不复活） */
export async function saveConflicts(rows: ConflictRow[]): Promise<number> {
  let created = 0
  await db.transaction('rw', [db.conflicts], async () => {
    for (const row of rows) {
      const exists = await db.conflicts
        .filter(
          (item) =>
            item.elementId === row.elementId &&
            item.recordIdA === row.recordIdA &&
            item.recordIdB === row.recordIdB &&
            !item.invalidated
        )
        .first()
      if (!exists) {
        await db.conflicts.put(toPlainRow(withInvalidFlag(row)))
        created += 1
      }
    }
  })
  return created
}

/** 解决差异：写入解决留痕并回写要素的初始状态（以最新现场状态为准） */
export async function resolveConflict(id: string, resolvedNote: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements], async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    const latest = await db.records.get(conflict.recordIdB)
    await db.conflicts.update(id, {
      state: '已解决',
      resolvedNote,
      resolvedAt: nowIso(),
      updatedAt: Date.now()
    } as never)
    if (latest) {
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        origin: getDeviceName(),
        updatedAt: Date.now()
      } as never)
    }
  })
}

/** 重新打开差异（误判回退） */
export async function reopenConflict(id: string): Promise<void> {
  await db.conflicts.update(id, { state: '待确认', resolvedNote: '', resolvedAt: '', updatedAt: Date.now() } as never)
}

export async function removeConflict(id: string): Promise<void> {
  await db.conflicts.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot extends HandoffEntitySet {
  name: string
  schemaVersion: number
  exportedAt: string
  conflicts: Conflict[]
  /** 导出方设备（旧备份无此字段，合并时按「旧备份」处理） */
  deviceId?: string
  deviceName?: string
}

/** 新行业务行若无来源标记，默认记为本机（手工新建路径都走这里或 update 路径） */
function withOrigin<T extends { origin?: string }>(row: T): T {
  if (typeof row.origin === 'string' && row.origin) return row
  return { ...row, origin: getDeviceName() }
}

function withInvalidFlag(row: ConflictRow): ConflictRow {
  return { ...row, invalidated: row.invalidated ?? false, invalidReason: row.invalidReason ?? '' }
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    deviceId: getDevice().id,
    deviceName: getDevice().name,
    scenes,
    elements,
    shootDays,
    records,
    conflicts
  }
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

/**
 * 整库覆盖导入（仅保留给「旧备份恢复」这类显式要求覆盖的场景）。
 * 离线交接请改用 utils/handoff.ts 的 record-by-record 合并。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.shootDays, db.records, db.conflicts], async () => {
    await Promise.all([
      db.scenes.clear(),
      db.elements.clear(),
      db.shootDays.clear(),
      db.records.clear(),
      db.conflicts.clear()
    ])
    await db.scenes.bulkPut(snapshot.scenes.map(stamp))
    await db.elements.bulkPut(snapshot.elements.map(stamp))
    await db.shootDays.bulkPut(snapshot.shootDays.map(stamp))
    await db.records.bulkPut(snapshot.records.map(stamp))
    await db.conflicts.bulkPut(
      snapshot.conflicts.map((row) => stamp({ ...row, invalidated: row.invalidated ?? false, invalidReason: row.invalidReason ?? '' }))
    )
  })
}

/** 清空全部数据并重新灌入演示数据（保留交接基线与待处理包，便于继续离线作业） */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.mergeIssues], async () => {
    await Promise.all([
      db.scenes.clear(),
      db.elements.clear(),
      db.shootDays.clear(),
      db.records.clear(),
      db.conflicts.clear(),
      db.mergeIssues.clear()
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, allConflicts, issues, packagesCount] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.toArray(),
    db.mergeIssues.where('state').equals('待裁决').count(),
    db.incomingPackages.count()
  ])
  return {
    scenes,
    elements,
    shootDays,
    records,
    conflicts: allConflicts.length,
    invalidated: allConflicts.filter((item) => item.invalidated).length,
    mergeIssues: issues,
    incomingPackages: packagesCount
  }
}
