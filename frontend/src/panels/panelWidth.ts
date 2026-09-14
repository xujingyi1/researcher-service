// 面板宽度持久化纯逻辑（issue #668 / spec #667）。
// key 家族 researcher:panel:<owner>:<view>:<panel>:<width|popped-width>，按用户 token 隔离
// （owner 解析用 auth 域共享的 tokenOwner，chat 草稿同一语义）。只记宽度——
// collapsed/popped 态不持久化（每次进页 inline）。Storage 由宿主注入可直测。
import { clampRange } from '@/panels/triState'
import type { WidthRange } from '@/panels/triState'

// inline 常驻宽度（px）。
export function panelWidthKey(owner: string, view: string, panel: string): string {
  return `researcher:panel:${owner}:${view}:${panel}:width`
}

// popped 浮层宽度（vw，见 POPPED_VW_RANGE）。与 inline 宽度**各存独立 key**
// （spec #667 US16 + US26：两者都被记住；只有"态"不记）。
export function panelPoppedWidthKey(owner: string, view: string, panel: string): string {
  return `researcher:panel:${owner}:${view}:${panel}:popped-width`
}

// 读恢复宽度：无 storage / 无值 / 非有限数 → null；有值经钳制返回（存储值可能过期或被手改）。
export function loadPanelWidth(
  storage: Storage | null,
  key: string,
  range: WidthRange,
): number | null {
  if (!storage) return null
  const raw = storage.getItem(key)
  if (raw === null) return null
  const width = Number(raw)
  if (!Number.isFinite(width)) return null
  return clampRange(width, range.min, range.max)
}

// 写宽度：storage 缺席静默跳过（隐私模式等）。
export function savePanelWidth(storage: Storage | null, key: string, width: number): void {
  storage?.setItem(key, String(width))
}
