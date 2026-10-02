<script setup lang="ts">
/**
 * OriginTag：行来源标记。
 * - 本机编辑 → 绿色（本机名）
 * - 交接并入 → 橙色（对端设备名，如「外景车」）
 * - 演示数据 / 旧备份 → 灰色
 */
import { computed } from 'vue'
import { originTagType } from '@/utils/device'

const props = withDefaults(
  defineProps<{
    origin?: string
    size?: 'small' | 'default' | 'large'
  }>(),
  { origin: '', size: 'small' }
)

const label = computed(() => props.origin || '本机')
</script>

<template>
  <el-tag :type="originTagType(origin)" :size="size" effect="plain">来源 · {{ label }}</el-tag>
</template>
