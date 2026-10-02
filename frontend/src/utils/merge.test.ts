/**
 * 离线交接合并逻辑测试（fake-indexeddb 模拟 IndexedDB）
 *
 * 场景：两台机器从同一基准出发，各自修改后回来合并。
 * - 本地改了 scene-1（location 字段）并新增 scene-3
 * - 对方改了 scene-1（director 字段）并新增 scene-2
 * 合并预期：
 * - scene-1 两边都改过 → 待裁决
 * - scene-2 对方新增 → 直接并入
 * - scene-3 本地新增 → 保留本地
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { db, saveBase, buildBaseFromCurrent, clearBase } from './db'
import { analyzeHandover, applyHandover, parseHandoverPackage } from './merge'
import type { HandoverPackage } from '@/types/handover'
import type { Scene } from '@/types/scene'

/** 构造一个最小可用的交接包 */
function makePackage(overrides: Partial<HandoverPackage>): HandoverPackage {
  return {
    name: 'gbcontinuity-db',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    source: '对方机器',
    scenes: [],
    elements: [],
    shootDays: [],
    records: [],
    conflicts: [],
    ...overrides
  }
}

/** 构造一场景 */
function makeScene(id: string, sceneNo: string, location: string, state: Scene['state'] = '未拍'): Scene {
  return { id, sceneNo, place: '内景', timeOfDay: '日', location, excerpt: '', shootOrder: 0, state }
}

describe('离线交接合并', () => {
  beforeAll(async () => {
    // 确保 DB 打开
    await db.open()
  })

  beforeEach(async () => {
    // 每个测试前清空全部表
    await Promise.all([
      db.scenes.clear(),
      db.elements.clear(),
      db.shootDays.clear(),
      db.records.clear(),
      db.conflicts.clear(),
      clearBase()
    ])
  })

  it('一边新增 → 直接并入', async () => {
    // 本地空库
    // 对方新增 scene-1
    const pkg = makePackage({
      source: '外景车A',
      scenes: [makeScene('sc-1', '1', '老宅')]
    })

    const analysis = await analyzeHandover(pkg)
    expect(analysis.counts.added.scenes).toBe(1)
    expect(analysis.counts.pending).toBe(0)

    const result = await applyHandover(pkg, analysis, {})
    expect(result.counts.added.scenes).toBe(1)

    const scenes = await db.scenes.toArray()
    expect(scenes).toHaveLength(1)
    expect(scenes[0].source).toBe('外景车A')
  })

  it('两边都改过 → 待裁决，场记选定后写入', async () => {
    // 本地：scene-1 location = 老宅客厅
    await db.scenes.put({
      ...makeScene('sc-1', '1', '老宅客厅'),
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    })
    // 基准：scene-1 location = 老宅（两边都从这版出发）
    const base = await buildBaseFromCurrent()
    base.scenes = [makeScene('sc-1', '1', '老宅')]
    await saveBase(base)

    // 对方：scene-1 location = 老宅码头
    const pkg = makePackage({
      source: '外景车A',
      base: JSON.stringify(base),
      scenes: [makeScene('sc-1', '1', '老宅码头')]
    })

    const analysis = await analyzeHandover(pkg)
    expect(analysis.counts.pending).toBe(1)
    expect(analysis.pending[0].table).toBe('scenes')
    expect(analysis.pending[0].recordId).toBe('sc-1')
    expect(analysis.pending[0].localModified).toBe(true)
    expect(analysis.pending[0].importedModified).toBe(true)

    // 场记选「导入版」
    const choices = { [analysis.pending[0].id]: 'imported' as const }
    const result = await applyHandover(pkg, analysis, choices)
    expect(result.counts.adjudicated).toBe(1)

    const scenes = await db.scenes.toArray()
    expect(scenes).toHaveLength(1)
    expect(scenes[0].location).toBe('老宅码头')
    expect(scenes[0].source).toBe('外景车A')
  })

  it('仅对方改过 → 直接并入', async () => {
    // 本地：scene-1 location = 老宅（没改过）
    await db.scenes.put({
      ...makeScene('sc-1', '1', '老宅'),
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    })
    // 基准：scene-1 location = 老宅
    const base = await buildBaseFromCurrent()
    await saveBase(base)

    // 对方：scene-1 location = 老宅码头（对方改过）
    const pkg = makePackage({
      source: '外景车A',
      base: JSON.stringify(base),
      scenes: [makeScene('sc-1', '1', '老宅码头')]
    })

    const analysis = await analyzeHandover(pkg)
    expect(analysis.counts.updated.scenes).toBe(1)
    expect(analysis.counts.pending).toBe(0)

    const result = await applyHandover(pkg, analysis, {})
    expect(result.counts.updated.scenes).toBe(1)

    const scenes = await db.scenes.toArray()
    expect(scenes[0].location).toBe('老宅码头')
  })

  it('旧备份（无 base）参与合并 → 差异全部进入待裁决', async () => {
    // 本地：scene-1 location = 老宅客厅
    await db.scenes.put({
      ...makeScene('sc-1', '1', '老宅客厅'),
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    })

    // 旧备份：无 base 字段
    const pkg = makePackage({
      source: '旧备份',
      scenes: [makeScene('sc-1', '1', '老宅码头')]
    })
    delete (pkg as Partial<HandoverPackage>).base

    const analysis = await analyzeHandover(pkg)
    // 无基准 → 两边都视为改过 → 待裁决
    expect(analysis.counts.pending).toBe(1)
  })

  it('引用已删除记录的差异 → 失效条目被清理', async () => {
    // 本地有 scene-1 + element-1 + record-1 + 冲突 cf-1
    await db.scenes.put({ ...makeScene('sc-1', '1', '老宅'), revision: 1, createdAt: 1, updatedAt: 1 })
    await db.elements.put({
      id: 'el-1',
      sceneId: 'sc-1',
      category: '服装',
      name: '风衣',
      initialState: '蓝',
      owner: '服化',
      critical: false,
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    })
    await db.records.put({
      id: 'rec-1',
      shootDayId: 'sd-1',
      elementId: 'el-1',
      sceneId: 'sc-1',
      takeNo: '1',
      currentState: '蓝',
      photoNote: '',
      recordedBy: '场记',
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    })
    await db.conflicts.put({
      id: 'cf-1',
      elementId: 'el-1',
      recordIdA: 'rec-1',
      recordIdB: 'rec-2', // rec-2 不存在 → 失效
      diffDesc: '差异',
      severity: '轻微',
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    })

    // 对方包：只有 scene-1，没有 element / record
    const pkg = makePackage({
      source: '对方机器',
      scenes: [makeScene('sc-1', '1', '老宅')]
    })

    const analysis = await analyzeHandover(pkg)
    expect(analysis.counts.invalidated).toBe(1)

    await applyHandover(pkg, analysis, {})

    // 失效冲突应被清理
    const conflicts = await db.conflicts.toArray()
    expect(conflicts).toHaveLength(0)
  })

  it('解析失败时抛出可读错误，不影响当前库', () => {
    expect(() => parseHandoverPackage('不是 JSON')).toThrow('不是合法的 JSON 文本')
    expect(() => parseHandoverPackage('{}')).toThrow('缺少 name 字段')
  })
})
