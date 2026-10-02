/**
 * 离线交接 store：管理交接包、合并分析、待裁决选择与合并状态。
 * 页面只读 store 并调用 actions，不把跨页状态留在组件内部。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { HandoverAnalysis, HandoverApplyResult, HandoverChoices, HandoverPackage } from '@/types/handover'
import { analyzeHandover, applyHandover, parseHandoverPackage } from '@/utils/merge'

export type HandoverStatus = 'idle' | 'analyzing' | 'ready' | 'merging' | 'done' | 'error'

export const useHandoverStore = defineStore('handover', () => {
  /** 待处理的交接包（出错时保留，不丢失） */
  const pendingPackage = ref<HandoverPackage | null>(null)
  /** 合并分析结果 */
  const analysis = ref<HandoverAnalysis | null>(null)
  /** 待裁决选择：pendingId → 'local' | 'imported' */
  const choices = ref<HandoverChoices>({})
  /** 合并应用结果 */
  const applyResult = ref<HandoverApplyResult | null>(null)
  /** 当前状态 */
  const status = ref<HandoverStatus>('idle')
  /** 错误信息 */
  const error = ref<string | null>(null)
  /** 交接包来源（输入框绑定） */
  const sourceInput = ref('')

  /** 解析交接包文本并分析 */
  async function analyze(text: string): Promise<void> {
    status.value = 'analyzing'
    error.value = null
    try {
      const pkg = parseHandoverPackage(text)
      pendingPackage.value = pkg
      sourceInput.value = pkg.source
      const result = await analyzeHandover(pkg)
      analysis.value = result
      // 默认全选「导入版」（对方版本），场记可逐条改选本地
      const defaultChoices: HandoverChoices = {}
      result.pending.forEach((item) => {
        defaultChoices[item.id] = 'imported'
      })
      choices.value = defaultChoices
      status.value = 'ready'
    } catch (err) {
      error.value = err instanceof Error ? err.message : '交接包解析失败'
      status.value = 'error'
      // 出错时保留当前库与待处理包：pendingPackage 已在解析成功时赋值，此处不清空
    }
  }

  /** 设置某条待裁决的选择 */
  function setChoice(pendingId: string, choice: 'local' | 'imported'): void {
    choices.value = { ...choices.value, [pendingId]: choice }
  }

  /** 批量设置选择 */
  function setAllChoices(choice: 'local' | 'imported'): void {
    if (!analysis.value) return
    const next: HandoverChoices = {}
    analysis.value.pending.forEach((item) => {
      next[item.id] = choice
    })
    choices.value = next
  }

  /** 应用交接合并 */
  async function confirmMerge(): Promise<void> {
    if (!pendingPackage.value || !analysis.value) return
    status.value = 'merging'
    error.value = null
    try {
      const result = await applyHandover(pendingPackage.value, analysis.value, choices.value)
      applyResult.value = result
      status.value = 'done'
    } catch (err) {
      error.value = err instanceof Error ? err.message : '合并失败'
      status.value = 'error'
      // 出错时保留当前库与待处理包，可重试
    }
  }

  /** 重置交接状态 */
  function reset(): void {
    pendingPackage.value = null
    analysis.value = null
    choices.value = {}
    applyResult.value = null
    status.value = 'idle'
    error.value = null
    sourceInput.value = ''
  }

  return {
    pendingPackage,
    analysis,
    choices,
    applyResult,
    status,
    error,
    sourceInput,
    analyze,
    setChoice,
    setAllChoices,
    confirmMerge,
    reset
  }
})
