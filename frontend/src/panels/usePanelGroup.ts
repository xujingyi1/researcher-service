// usePanelGroup —— 同页面板组协调器（spec #667 US25：同页一次只弹一个浮层）。
// 一个页面（WikiView / ChatView）建一个组实例，把该页的三态面板注册进来；
// 成员收到三态事件时经组内互斥**纯函数** transitionGroup 算出整组目标态并落回各成员——
// 互斥规则单一实现，不在 view 里各写一份（#667「四个面板统一接同一套三态包装逻辑，不各自实现」）。
//
// 关键约束：**不是模块级全局单例**——每次调用返回独立闭包，随宿主组件 setup 创建、
// 随 unmount 消亡；成员在 usePanelTriState 里注册、onUnmounted 注销。故 wiki 页的组
// 与 chat 页的组互不相干，路由重进也是全新实例。
import { transitionGroup } from '@/panels/triState'
import type { GroupMember, PanelEvent, PanelState } from '@/panels/triState'

export interface PanelGroup {
  /** 注册成员；返回注销函数（成员 unmount 时调用） */
  register: (id: string, read: () => PanelState, write: (state: PanelState) => void) => () => void
  /** 成员收到三态事件：整组（含互斥收回）落定 */
  apply: (id: string, event: PanelEvent) => void
}

export function usePanelGroup(): PanelGroup {
  // 只读 + 写回两句柄：组不持有状态（状态仍在各成员的 ref 里），只做协调。
  const members = new Map<string, { read: () => PanelState; write: (state: PanelState) => void }>()

  function snapshot(): GroupMember[] {
    return [...members.entries()].map(([id, m]) => ({ id, state: m.read() }))
  }

  function apply(id: string, event: PanelEvent): void {
    for (const member of transitionGroup(snapshot(), id, event)) {
      members.get(member.id)?.write(member.state)
    }
  }

  function register(
    id: string,
    read: () => PanelState,
    write: (state: PanelState) => void,
  ): () => void {
    members.set(id, { read, write })
    return () => {
      members.delete(id)
    }
  }

  return { register, apply }
}
