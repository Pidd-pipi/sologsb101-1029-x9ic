/**
 * 设备标识：外景车 / 驻地两台笔记本各自的离线身份。
 * 存 localStorage（不进 IndexedDB），清空业务库或重置演示数据后身份不变，
 * 交接包靠它标明「来源」，业务行靠它记录最后修改方。
 */
import { createId } from './uuid'

const DEVICE_ID_KEY = 'gbcontinuity.deviceId'
const DEVICE_NAME_KEY = 'gbcontinuity.deviceName'

/** 演示播种数据的来源标识（两台新机器播种内容完全一致，首次交接据此免裁决） */
export const ORIGIN_SEED = '演示数据'

export interface DeviceInfo {
  id: string
  name: string
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等场景下落空也不阻塞主流程 */
  }
}

/** 本机设备 ID（首次调用生成，终身不变） */
export function getDeviceId(): string {
  let id = read(DEVICE_ID_KEY)
  if (!id) {
    id = createId('device')
    write(DEVICE_ID_KEY, id)
  }
  return id
}

/** 本机设备名（可由场记改为「外景车」「驻地」等） */
export function getDeviceName(): string {
  return read(DEVICE_NAME_KEY)?.trim() || `本机-${getDeviceId().slice(-4)}`
}

export function setDeviceName(name: string): void {
  const trimmed = name.trim()
  write(DEVICE_NAME_KEY, trimmed || `本机-${getDeviceId().slice(-4)}`)
}

export function getDevice(): DeviceInfo {
  return { id: getDeviceId(), name: getDeviceName() }
}

/** 该来源是否算本机（含历史遗留的空来源） */
export function isLocalOrigin(origin?: string): boolean {
  return !origin || origin === getDeviceName()
}

/** 来源标签底色：演示数据 / 本机 / 对端（交接并入） */
export function originTagType(origin?: string): 'info' | 'success' | 'warning' {
  if (!origin || origin === getDeviceName()) return 'success'
  if (origin === ORIGIN_SEED) return 'info'
  return 'warning'
}
