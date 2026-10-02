/**
 * 按要素取最近两次现场记录做字段级比对，派生差异列表与严重程度。
 * 被差异比对页、现场记录页与报告页共同消费。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ShootDayRow, ElementRow, RecordRow } from '@/utils/db'
import { generateDiffCandidates, type DiffCandidate } from '@/utils/diff'

export type { DiffCandidate }

export interface ContinuityDiffResult {
  /** 全部存在差异的候选条目（按严重程度倒序） */
  candidates: ComputedRef<DiffCandidate[]>
  /** 差异条目数 */
  diffCount: ComputedRef<number>
  /** 阻断级差异数 */
  blockingCount: ComputedRef<number>
  /** 指定要素是否存在差异 */
  hasDiff: (elementId: string) => boolean
  /** 指定场次的差异条数 */
  countByScene: (sceneId: string) => number
}

/**
 * @param records    全部现场记录
 * @param elements   全部连戏要素
 * @param shootDays  全部拍摄日（用于把记录排到时间轴上）
 */
export function useContinuityDiff(
  records: Ref<RecordRow[]>,
  elements: Ref<ElementRow[]>,
  shootDays: Ref<ShootDayRow[]>
): ContinuityDiffResult {
  const candidates = computed<DiffCandidate[]>(() =>
    generateDiffCandidates(records.value, elements.value, shootDays.value)
  )

  return {
    candidates,
    diffCount: computed(() => candidates.value.length),
    blockingCount: computed(() => candidates.value.filter((item) => item.severity === '阻断').length),
    hasDiff: (elementId: string) => candidates.value.some((item) => item.elementId === elementId),
    countByScene: (sceneId: string) => candidates.value.filter((item) => item.sceneId === sceneId).length
  }
}
