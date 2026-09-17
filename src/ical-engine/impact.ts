// 变更影响分析
// 比较当前查询范围内：原始日历（按原文规则、全部例外生效）展开的生效实例
// 与规则编辑、例外停用后的生效实例。
// 实例身份：UID + 原始 recurrence key（RECURRENCE-ID 槽位），
// 因此例外把实例改时移动是同一身份的 start/end 变化，而不是一删一增。

import type { Instance } from './types';
import { formatWall } from '../utils/format';

export type ChangeKind =
  | 'added' // 仅候选（编辑后）侧存在
  | 'removed' // 仅原始侧存在
  | 'start' // 开始时间移动
  | 'end' // 结束时间移动
  | 'summary' // 标题变化
  | 'location' // 地点变化
  | 'status'; // 状态变化

export interface FieldChange {
  kind: ChangeKind;
  label: string;
  before: string;
  after: string;
}

export interface ImpactChange {
  /** 实例身份：uid#recurKey */
  id: string;
  uid: string;
  /** 原始 recurrence key（槽位绝对时间，秒） */
  recurKey: number;
  /** 原始侧实例（新增时为 null） */
  before: Instance | null;
  /** 候选侧实例（移除时为 null） */
  after: Instance | null;
  /** added / removed 或各字段变化（modified 时至少一项） */
  kinds: ChangeKind[];
  /** 字段级前后值，added/removed 时为空 */
  fields: FieldChange[];
}

/** UID + 原始 recurrence key 构成的实例身份 */
export function impactId(inst: Instance): string {
  return `${inst.uid}#${inst.recurKey}`;
}

const KIND_LABEL: Record<ChangeKind, string> = {
  added: '新增',
  removed: '移除',
  start: '开始移动',
  end: '结束移动',
  summary: '标题',
  location: '地点',
  status: '状态',
};

function textOr(v: string, kind: 'summary' | 'location'): string {
  if (v.trim()) return v;
  return kind === 'summary' ? '（无标题）' : '（无地点）';
}

function timeText(utcSec: number, inst: Instance): string {
  return formatWall(utcSec, inst.tzid, inst.isAllDay);
}

function field(kind: ChangeKind, before: string, after: string): FieldChange {
  return { kind, label: KIND_LABEL[kind], before, after };
}

/**
 * 比较两侧生效实例。
 * @param baseline 原始日历（无编辑、无停用）在当前范围内的生效实例
 * @param effective 规则编辑 / 例外停用后在当前范围内的生效实例
 */
export function diffInstances(baseline: Instance[], effective: Instance[]): ImpactChange[] {
  const beforeMap = new Map<string, Instance>();
  const afterMap = new Map<string, Instance>();
  for (const i of baseline) {
    const id = impactId(i);
    if (!beforeMap.has(id)) beforeMap.set(id, i);
  }
  for (const i of effective) {
    const id = impactId(i);
    if (!afterMap.has(id)) afterMap.set(id, i);
  }

  const changes: ImpactChange[] = [];

  // 移除：仅原始侧存在；新增：仅候选侧存在
  for (const [id, b] of beforeMap) {
    const a = afterMap.get(id) ?? null;
    if (!a) {
      changes.push({
        id,
        uid: b.uid,
        recurKey: b.recurKey,
        before: b,
        after: null,
        kinds: ['removed'],
        fields: [],
      });
    }
  }
  for (const [id, a] of afterMap) {
    const b = beforeMap.get(id) ?? null;
    if (!b) {
      changes.push({
        id,
        uid: a.uid,
        recurKey: a.recurKey,
        before: null,
        after: a,
        kinds: ['added'],
        fields: [],
      });
    }
  }

  // 同身份：逐字段比较前后值
  for (const [id, b] of beforeMap) {
    const a = afterMap.get(id);
    if (!a) continue;
    const fields: FieldChange[] = [];
    if (a.startUtc !== b.startUtc) {
      fields.push(field('start', timeText(b.startUtc, b), timeText(a.startUtc, a)));
    }
    if (a.endUtc !== b.endUtc) {
      fields.push(field('end', timeText(b.endUtc, b), timeText(a.endUtc, a)));
    }
    if (a.summary !== b.summary) {
      fields.push(field('summary', textOr(b.summary, 'summary'), textOr(a.summary, 'summary')));
    }
    if (a.location !== b.location) {
      fields.push(field('location', textOr(b.location, 'location'), textOr(a.location, 'location')));
    }
    if ((a.status || 'CONFIRMED') !== (b.status || 'CONFIRMED')) {
      fields.push(field('status', b.status || 'CONFIRMED', a.status || 'CONFIRMED'));
    }
    if (fields.length > 0) {
      changes.push({
        id,
        uid: b.uid,
        recurKey: b.recurKey,
        before: b,
        after: a,
        kinds: fields.map((f) => f.kind),
        fields,
      });
    }
  }

  // 先按原始/候选开始时间排序，再按 UID 稳定排序
  changes.sort((x, y) => {
    const tx = x.after?.startUtc ?? x.before?.startUtc ?? x.recurKey;
    const ty = y.after?.startUtc ?? y.before?.startUtc ?? y.recurKey;
    return tx - ty || x.uid.localeCompare(y.uid);
  });
  return changes;
}
