/**
 * 离线交接合并引擎（按记录编号，而非整库覆盖）。
 *
 * 外景车 / 驻地两台笔记本断网各自修改，回到一起后用交接包做三方合并：
 * - 以 syncState 中「上次交接时对端的行」为 base：只有一边改过 → 直接并入；两边都改 → 进 mergeIssues 保留两版
 * - 首次交接（无 base）按来源启发式判定：本机演示行未动过则直接接收，否则进待裁决
 * - 现场记录落定（并入 / 裁决）后立即重算差异：失效条目标记保留，新增差异自动生成
 * - 导入先落「待处理包」再进事务；出错回滚、当前库不动、包保留为「出错」可重试
 * - 旧版整库备份（无设备字段、无时间戳）同样可作为交接包参与合并
 */
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict, ConflictSeverity } from '../types/conflict'
import {
  db,
  ROW_REVISION,
  type HandoffEntitySet,
  type IncomingPackageRow,
  type MergeIssueRow,
  type MergeTableKey,
  type RecordRow,
  type ElementRow,
  type ShootDayRow,
  type ConflictRow
} from './db'
import { describeDiffs, diffRecords, severityOf, sortBySeverity, type FieldDiff } from './diff'
import { createId, nowIso } from './uuid'
import { downloadJson } from './export'
import { ORIGIN_SEED, getDevice, getDeviceName } from './device'

/* ------------------------------ 包结构 ------------------------------ */

export interface HandoffPackage extends HandoffEntitySet {
  kind?: string
  name?: string
  schemaVersion?: number
  exportedAt: string
  deviceId: string
  deviceName: string
  conflicts?: Conflict[]
}

/** 旧备份设备名（无设备字段的整库备份统一标识） */
export const LEGACY_ORIGIN = '旧备份'

export const TABLE_LABELS: Record<MergeTableKey, string> = {
  scenes: '场次',
  elements: '连戏要素',
  shootDays: '拍摄日',
  records: '现场记录'
}

export const MERGE_TABLES: MergeTableKey[] = ['scenes', 'elements', 'shootDays', 'records']

/** 本次合并的结果摘要（页面提示与待处理包留档共用） */
export interface MergeSummary {
  peerDeviceId: string
  peerDeviceName: string
  exportedAt: string
  packageId: string
  added: Record<MergeTableKey, number>
  updated: Record<MergeTableKey, number>
  conflicts: Record<MergeTableKey, number>
  unchanged: number
  invalidatedConflicts: number
  createdConflicts: number
  updatedConflicts: number
}

/* ------------------------------ 解析校验 ------------------------------ */

type RawRow = Record<string, unknown>

function asArray(value: unknown, field: string): RawRow[] {
  if (!Array.isArray(value)) throw new Error(`交接包缺少 ${field} 数组字段`)
  return value.filter((item): item is RawRow => typeof item === 'object' && item !== null)
}

/** 校验并解析交接包 / 旧备份，失败时抛出可读错误（调用方负责保留包与当前库） */
export function parseHandoff(text: string): HandoffPackage {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('交接包根节点必须是对象')
  const candidate = parsed as Partial<HandoffPackage>
  if (!Array.isArray(candidate.scenes)) throw new Error('缺少 scenes 数组字段，不是本应用的交接包 / 备份')

  const entities = {
    scenes: asArray(candidate.scenes, 'scenes') as unknown as Scene[],
    elements: asArray(candidate.elements, 'elements') as unknown as Element[],
    shootDays: asArray(candidate.shootDays, 'shootDays') as unknown as ShootDay[],
    records: asArray(candidate.records, 'records') as unknown as ContinuityRecord[]
  }

  for (const table of MERGE_TABLES) {
    const seen = new Set<string>()
    for (const row of entities[table]) {
      if (typeof row.id !== 'string' || !row.id) throw new Error(`${TABLE_LABELS[table]}存在没有编号的记录，无法按编号合并`)
      if (seen.has(row.id)) throw new Error(`${TABLE_LABELS[table]}中编号 ${row.id} 重复，包可能已损坏`)
      seen.add(row.id)
    }
  }

  const exportedAt = typeof candidate.exportedAt === 'string' ? candidate.exportedAt : ''
  const isLegacy = typeof candidate.deviceId !== 'string' || !candidate.deviceId
  return {
    ...entities,
    conflicts: Array.isArray(candidate.conflicts) ? (candidate.conflicts as Conflict[]) : [],
    kind: typeof candidate.kind === 'string' ? candidate.kind : undefined,
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : undefined,
    exportedAt,
    deviceId: isLegacy ? `legacy:${exportedAt || createId('pkg')}` : candidate.deviceId as string,
    deviceName: isLegacy ? LEGACY_ORIGIN : (candidate.deviceName as string) || LEGACY_ORIGIN
  }
}

/* ------------------------------ 差异候选 ------------------------------ */

export interface DiffCandidate {
  elementId: string
  critical: boolean
  sceneId: string
  a: RecordRow
  b: RecordRow
  diffs: FieldDiff[]
  severity: ConflictSeverity
  desc: string
}

/** 记录时间轴：先按拍摄日日期，再按镜次排序（与 useContinuityDiff 保持同一口径） */
function buildTimeline(records: RecordRow[], shootDays: ShootDayRow[]): RecordRow[] {
  const dateOf = (record: RecordRow): string => shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''
  return [...records].sort(
    (a, b) => dateOf(a).localeCompare(dateOf(b)) || a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
  )
}

/** 由全部记录 / 要素 / 拍摄日推导「每要素最近两次记录」的差异候选 */
export function buildDiffCandidates(
  records: RecordRow[],
  elements: ElementRow[],
  shootDays: ShootDayRow[]
): DiffCandidate[] {
  const result: DiffCandidate[] = []
  elements.forEach((element) => {
    const own = buildTimeline(records.filter((record) => record.elementId === element.id), shootDays)
    if (own.length < 2) return
    const a = own[own.length - 2]
    const b = own[own.length - 1]
    const diffs = diffRecords(a, b)
    const severity = severityOf(diffs, element.critical)
    if (!severity) return
    result.push({
      elementId: element.id,
      critical: element.critical,
      sceneId: element.sceneId,
      a,
      b,
      diffs,
      severity,
      desc: describeDiffs(diffs)
    })
  })
  return sortBySeverity(result)
}

/* ------------------------------ 三方合并 ------------------------------ */

const SIGNATURE_IGNORE = new Set(['revision', 'createdAt', 'updatedAt', 'origin'])

/** 行内容指纹：忽略修订号 / 时间戳 / 来源，只比对业务字段 */
function signature(row: RawRow): string {
  const keys = Object.keys(row).filter((key) => !SIGNATURE_IGNORE.has(key)).sort()
  return JSON.stringify(keys.map((key) => [key, row[key]]))
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 包行落库：保留原编号与时间轴信息，来源记为对端（旧备份记「旧备份」） */
function stampIncoming<T extends RawRow>(row: T, origin: string): T {
  const now = Date.now()
  return {
    ...row,
    origin: typeof row.origin === 'string' && row.origin ? row.origin : origin,
    revision: ROW_REVISION,
    createdAt: num(row.createdAt) || now,
    updatedAt: num(row.updatedAt) || now
  } as T
}

function emptyCounters<T extends string>(keys: readonly T[]): Record<T, number> {
  return keys.reduce((acc, key) => {
    acc[key] = 0
    return acc
  }, {} as Record<T, number>)
}

/**
 * 全量重算差异表：
 * - 记录缺失 / 裁决后已无差异的旧条目标 invalidated（留痕保留，不删）
 * - 仍有差异的待确认条目刷新描述与严重程度
 * - 新出现的最近两次记录差异生成「待确认」条目
 */
export async function reconcileConflicts(): Promise<{ invalidated: number; created: number; updated: number }> {
  const [records, elements, shootDays, conflicts] = await Promise.all([
    db.records.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.conflicts.toArray()
  ])
  const candidates = buildDiffCandidates(records, elements, shootDays)
  const recordById = new Map(records.map((item) => [item.id, item]))
  const elementById = new Map(elements.map((item) => [item.id, item]))

  let invalidated = 0
  let updated = 0
  let created = 0
  const matchedPairs = new Set<string>()

  const pairKey = (elementId: string, a: string, b: string): string =>
    `${elementId}|${[a, b].sort().join('⇄')}`

  await db.transaction('rw', db.conflicts, async () => {
    for (const conflict of conflicts) {
      if (conflict.invalidated) continue
      const ra = recordById.get(conflict.recordIdA)
      const rb = recordById.get(conflict.recordIdB)
      if (!ra || !rb) {
        await db.conflicts.update(conflict.id, {
          invalidated: true,
          invalidReason: '关联的现场记录在合并后不存在',
          updatedAt: Date.now()
        } as never)
        invalidated += 1
        continue
      }
      const diffs = diffRecords(ra, rb)
      if (diffs.length === 0) {
        await db.conflicts.update(conflict.id, {
          invalidated: true,
          invalidReason: '现场记录定下来后两版已无差异',
          updatedAt: Date.now()
        } as never)
        invalidated += 1
        continue
      }
      matchedPairs.add(pairKey(conflict.elementId, ra.id, rb.id))
      // 已解决的保留处理结论；待确认的按最新记录刷新
      if (conflict.state === '待确认') {
        const desc = describeDiffs(diffs)
        const element = elementById.get(conflict.elementId)
        const severity = severityOf(diffs, element?.critical ?? false)
        if (desc !== conflict.diffDesc || (severity && severity !== conflict.severity)) {
          await db.conflicts.update(conflict.id, {
            diffDesc: desc,
            ...(severity ? { severity } : {}),
            updatedAt: Date.now()
          } as never)
          updated += 1
        }
      }
    }

    const now = Date.now()
    for (const candidate of candidates) {
      if (matchedPairs.has(pairKey(candidate.elementId, candidate.a.id, candidate.b.id))) continue
      const row: ConflictRow = {
        id: createId('conflict'),
        elementId: candidate.elementId,
        recordIdA: candidate.a.id,
        recordIdB: candidate.b.id,
        diffDesc: candidate.desc,
        severity: candidate.severity,
        state: '待确认',
        resolvedNote: '',
        resolvedAt: '',
        invalidated: false,
        invalidReason: '',
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      }
      await db.conflicts.put(row)
      created += 1
    }
  })

  return { invalidated, created, updated }
}

/**
 * 按记录编号合并交接包。整体在一个事务内：任一行写入失败则全部回滚，当前库保持原样。
 * 调用方应先把包存入 incomingPackages（出错时也要留档）。
 */
export async function mergeHandoff(pkg: HandoffPackage, packageId: string): Promise<MergeSummary> {
  const device = getDevice()
  if (pkg.deviceId === device.id) throw new Error('这是本机导出的包，不能交接给自己')

  const summary: MergeSummary = {
    peerDeviceId: pkg.deviceId,
    peerDeviceName: pkg.deviceName,
    exportedAt: pkg.exportedAt,
    packageId,
    added: emptyCounters(MERGE_TABLES),
    updated: emptyCounters(MERGE_TABLES),
    conflicts: emptyCounters(MERGE_TABLES),
    unchanged: 0,
    invalidatedConflicts: 0,
    createdConflicts: 0,
    updatedConflicts: 0
  }

  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.syncState, db.mergeIssues],
    async () => {
      const localSets: Record<MergeTableKey, RawRow[]> = {
        scenes: (await db.scenes.toArray()) as unknown as RawRow[],
        elements: (await db.elements.toArray()) as unknown as RawRow[],
        shootDays: (await db.shootDays.toArray()) as unknown as RawRow[],
        records: (await db.records.toArray()) as unknown as RawRow[]
      }
      const baseState = await db.syncState.get(pkg.deviceId)
      const now = Date.now()
      const issues: MergeIssueRow[] = []

      for (const table of MERGE_TABLES) {
        const localById = new Map(localSets[table].map((row) => [String(row.id), row]))
        const baseById = new Map<string, RawRow>()
        for (const row of (baseState?.[table] ?? []) as unknown as RawRow[]) {
          baseById.set(String(row.id), row)
        }

        for (const incomingRaw of pkg[table] as unknown as RawRow[]) {
          const id = String(incomingRaw.id)
          const local = localById.get(id)
          const incoming = stampIncoming(incomingRaw, pkg.deviceName)

          if (!local) {
            // 对端新增（本机没有这条编号）→ 直接并入
            await db[table].put(incoming as never)
            summary.added[table] += 1
            continue
          }

          const sigLocal = signature(local)
          const sigIncoming = signature(incoming)
          if (sigLocal === sigIncoming) {
            summary.unchanged += 1
            continue
          }

          const base = baseById.get(id)
          const incomingChanged = !base || signature(base) !== sigIncoming
          const localChanged = !base || signature(base) !== sigLocal

          let decision: 'take' | 'keep' | 'conflict'
          if (!base) {
            // 首次与该对端交接：无共同基线，按来源启发式判定
            const localOrigin = typeof local.origin === 'string' ? local.origin : ''
            const incomingOrigin = typeof incomingRaw.origin === 'string' ? incomingRaw.origin : ''
            if (localOrigin === ORIGIN_SEED) {
              // 本机演示行未动过 → 直接接收对端版
              decision = 'take'
            } else if (incomingOrigin === ORIGIN_SEED) {
              decision = 'keep'
            } else if (!incomingOrigin && localOrigin !== pkg.deviceName) {
              // 旧备份行无来源、无法证明单边修改 → 交场记裁决，绝不静默覆盖
              decision = 'conflict'
            } else {
              decision = 'conflict'
            }
          } else if (incomingChanged && !localChanged) {
            decision = 'take'
          } else if (!incomingChanged && localChanged) {
            decision = 'keep'
          } else {
            decision = 'conflict'
          }

          if (decision === 'take') {
            await db[table].put(incoming as never)
            summary.updated[table] += 1
          } else if (decision === 'keep') {
            summary.unchanged += 1
          } else {
            issues.push({
              id: createId('issue'),
              table,
              recordId: id,
              packageId,
              peerDeviceName: pkg.deviceName,
              local: stripMeta(local),
              incoming: stripMeta(incoming),
              localUpdatedAt: num(local.updatedAt),
              incomingUpdatedAt: num(incoming.updatedAt),
              exportedAt: pkg.exportedAt,
              state: '待裁决',
              decidedAt: '',
              revision: ROW_REVISION,
              createdAt: now,
              updatedAt: now
            })
            summary.conflicts[table] += 1
          }
        }
      }

      if (issues.length > 0) await db.mergeIssues.bulkPut(issues)

      // 记录本次交接时对端的全貌，作为下次三方合并的 base
      await db.syncState.put({
        peerDeviceId: pkg.deviceId,
        peerDeviceName: pkg.deviceName,
        scenes: pkg.scenes,
        elements: pkg.elements,
        shootDays: pkg.shootDays,
        records: pkg.records,
        updatedAt: now
      })
    }
  )

  // 业务行落定后立即重算差异与报告（事务外执行，内部自带事务）
  const rec = await reconcileConflicts()
  summary.invalidatedConflicts = rec.invalidated
  summary.createdConflicts = rec.created
  summary.updatedConflicts = rec.updated
  return summary
}

function stripMeta(row: RawRow): RawRow {
  const copy = { ...row }
  SIGNATURE_IGNORE.forEach((key) => delete copy[key])
  return copy
}

/* --------------------------- 待裁决写回 --------------------------- */

export type IssueDecision = 'local' | 'incoming'

/**
 * 场记对一条两边都改过的记录做出选择后写回业务表。
 * 现场记录裁决落定后立即重算差异条目。
 */
export async function decideMergeIssue(issueId: string, choice: IssueDecision): Promise<void> {
  const issue = await db.mergeIssues.get(issueId)
  if (!issue) throw new Error('待裁决记录不存在')
  if (issue.state !== '待裁决') throw new Error('该条已经裁决过')

  const chosenRaw = choice === 'local' ? issue.local : issue.incoming
  const origin = choice === 'local' ? getDeviceName() : issue.peerDeviceName
  const now = Date.now()
  const row = {
    ...chosenRaw,
    origin,
    revision: ROW_REVISION,
    createdAt: choice === 'local' ? issue.localUpdatedAt || now : issue.incomingUpdatedAt || now,
    updatedAt: now
  }

  await db.transaction('rw', [db[issue.table] as never, db.mergeIssues], async () => {
    await (db[issue.table] as { put: (r: unknown) => Promise<unknown> }).put(row)
    await db.mergeIssues.update(issueId, { state: choice === 'local' ? '采用本机' : '采用对端', decidedAt: nowIso(), updatedAt: now })
  })

  // 任何业务表裁决后都重算；只有现场记录会实际改变差异结果
  await reconcileConflicts()
}

/* --------------------------- 待处理包管理 --------------------------- */

/** 导入入口：先留存待处理包，再合并；出错则当前库不动、包标记为「出错」 */
export async function importHandoffText(text: string, filename: string): Promise<MergeSummary> {
  let pkg: HandoffPackage
  try {
    pkg = parseHandoff(text)
  } catch (err) {
    await savePackage({
      filename,
      status: '出错',
      originName: '',
      exportedAt: '',
      payload: text,
      error: err instanceof Error ? err.message : '解析失败'
    })
    throw err
  }

  const now = Date.now()
  const packageId = createId('pkg')
  await savePackage({
    id: packageId,
    filename,
    status: '待处理',
    originName: pkg.deviceName,
    exportedAt: pkg.exportedAt,
    payload: text,
    error: '',
    resultSummary: ''
  })

  try {
    const summary = await mergeHandoff(pkg, packageId)
    await db.incomingPackages.update(packageId, {
      status: '已并入',
      resultSummary: formatSummary(summary),
      updatedAt: now
    })
    return summary
  } catch (err) {
    // 事务已回滚 → 当前库保持导入前状态；包留档可改后重试
    await db.incomingPackages.update(packageId, {
      status: '出错',
      error: err instanceof Error ? err.message : '合并失败',
      updatedAt: now
    })
    throw err
  }
}

/** 重试一个出错 / 待处理的留存包（包本身不可变，重新解析合并） */
export async function retryIncomingPackage(packageRow: IncomingPackageRow): Promise<MergeSummary> {
  const pkg = parseHandoff(packageRow.payload) // 坏包直接抛出，由页面提示
  await db.incomingPackages.update(packageRow.id, { status: '待处理', error: '', updatedAt: Date.now() })
  try {
    const summary = await mergeHandoff(pkg, packageRow.id)
    await db.incomingPackages.update(packageRow.id, {
      status: '已并入',
      originName: pkg.deviceName,
      exportedAt: pkg.exportedAt,
      resultSummary: formatSummary(summary),
      updatedAt: Date.now()
    })
    return summary
  } catch (err) {
    await db.incomingPackages.update(packageRow.id, {
      status: '出错',
      error: err instanceof Error ? err.message : '合并失败',
      updatedAt: Date.now()
    })
    throw err
  }
}

export async function savePackage(input: Partial<IncomingPackageRow> & Pick<IncomingPackageRow, 'filename' | 'status' | 'payload'>): Promise<string> {
  const now = Date.now()
  const row: IncomingPackageRow = {
    id: input.id ?? createId('pkg'),
    filename: input.filename,
    status: input.status,
    originName: input.originName ?? '',
    exportedAt: input.exportedAt ?? '',
    payload: input.payload,
    error: input.error ?? '',
    resultSummary: input.resultSummary ?? '',
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  await db.incomingPackages.put(row)
  return row.id
}

export function formatSummary(s: MergeSummary): string {
  const parts = MERGE_TABLES.map((table) => {
    const items = [`新增 ${s.added[table]}`, `改并 ${s.updated[table]}`, `待裁决 ${s.conflicts[table]}`]
    return `${TABLE_LABELS[table]}：${items.join(' / ')}`
  })
  return `${parts.join('；')}；差异：失效 ${s.invalidatedConflicts}、新增 ${s.createdConflicts}、刷新 ${s.updatedConflicts}`
}

/* ------------------------------ 导出交接包 ------------------------------ */

/** 构造离线交接包：带设备身份与全部业务行（含时间戳，供对端三方合并） */
export async function buildHandoffPackage(): Promise<HandoffPackage> {
  const [scenes, elements, shootDays, records, conflicts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray()
  ])
  const device = getDevice()
  return {
    kind: 'gbcontinuity-handoff',
    name: 'gbcontinuity-db',
    schemaVersion: 2,
    exportedAt: nowIso(),
    deviceId: device.id,
    deviceName: device.name,
    scenes,
    elements,
    shootDays,
    records,
    conflicts: conflicts.map((item) => ({ ...item }))
  }
}

/** 下载交接包文件（纯前端触发浏览器下载） */
export async function downloadHandoff(): Promise<void> {
  const pkg = await buildHandoffPackage()
  const safeName = pkg.deviceName.replace(/[\\/:*?"<>|\s]+/g, '')
  downloadJson(`连戏交接包-${safeName}-${pkg.exportedAt.slice(0, 10)}.json`, JSON.stringify(pkg, null, 2))
}
