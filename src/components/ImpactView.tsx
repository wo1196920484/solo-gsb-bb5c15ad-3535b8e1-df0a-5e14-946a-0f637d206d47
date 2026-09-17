import { useMemo, useState } from 'react';
import type { ChangeKind, ImpactChange } from '../ical-engine/impact';
import { formatWall } from '../utils/format';

interface ImpactViewProps {
  changes: ImpactChange[];
  selectedId: string | null;
  /** 点击差异项：side 指定定位“变更前”还是“变更后”实例 */
  onSelect: (side: 'before' | 'after', change: ImpactChange) => void;
}

const ALL_KINDS: ChangeKind[] = ['added', 'removed', 'start', 'end', 'summary', 'location', 'status'];

const KIND_NAME: Record<ChangeKind, string> = {
  added: '新增',
  removed: '移除',
  start: '开始移动',
  end: '结束移动',
  summary: '标题',
  location: '地点',
  status: '状态',
};

function slotText(change: ImpactChange): string {
  const ref = change.after ?? change.before;
  if (!ref) return String(change.recurKey);
  return formatWall(change.recurKey, ref.tzid, ref.isAllDay);
}

function rangeText(inst: NonNullable<ImpactChange['before']>): string {
  if (inst.isAllDay) return formatWall(inst.startUtc, inst.tzid, true);
  return `${formatWall(inst.startUtc, inst.tzid, false)} → ${formatWall(inst.endUtc, inst.tzid, false)}`;
}

function orEmpty(v: string, kind: 'summary' | 'location'): string {
  return v.trim() ? v : kind === 'summary' ? '（无标题）' : '（无地点）';
}

export function ImpactView({ changes, selectedId, onSelect }: ImpactViewProps) {
  const [activeKinds, setActiveKinds] = useState<Set<ChangeKind>>(new Set());

  const counts = useMemo(() => {
    const m = new Map<ChangeKind, number>();
    for (const k of ALL_KINDS) m.set(k, 0);
    for (const c of changes) for (const k of c.kinds) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, [changes]);

  const rows = useMemo(() => {
    if (activeKinds.size === 0) return changes;
    return changes.filter((c) => c.kinds.some((k) => activeKinds.has(k)));
  }, [changes, activeKinds]);

  const toggleKind = (k: ChangeKind): void => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  if (changes.length === 0) {
    return (
      <div className="empty-hint">
        当前规则编辑与例外停用在查询范围内没有产生实例变化
        <div className="impact-empty-sub">编辑中栏 RRULE 或停用具条例外后，差异会立即在此列出</div>
      </div>
    );
  }

  return (
    <>
      <div className="filter-bar impact-filters">
        {ALL_KINDS.map((k) => {
          const n = counts.get(k) ?? 0;
          const on = activeKinds.has(k);
          return (
            <button
              key={k}
              className={`kind-chip ${k} ${on ? 'on' : ''}`}
              disabled={n === 0 && !on}
              onClick={() => toggleKind(k)}
              title={on ? '点击移除该筛选' : '只看该变更类型'}
            >
              {KIND_NAME[k]} {n}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        {activeKinds.size > 0 && (
          <button className="ghost" onClick={() => setActiveKinds(new Set())}>
            清除筛选
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="empty-hint">没有符合所选类型的变更</div>
      ) : (
        <table className="instance-table impact-table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>类型</th>
              <th style={{ width: 175 }}>实例身份（原始槽位）</th>
              <th>前后值</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const primary = c.kinds[0];
              const pick = (side: 'before' | 'after') => {
                const inst = side === 'before' ? c.before : c.after;
                if (inst) onSelect(side, c);
              };
              return (
                <tr
                  key={c.id}
                  className={`instance-row impact-row ${selectedId === c.id ? 'selected' : ''}`}
                  onClick={() => pick(c.after ? 'after' : 'before')}
                >
                  <td>
                    {c.kinds.map((k) => (
                      <span key={k} className={`kind-badge ${k}`}>
                        {KIND_NAME[k]}
                      </span>
                    ))}
                  </td>
                  <td className="cell-time">
                    {slotText(c)}
                    <div className="clock impact-uid">{c.uid}</div>
                    <div className="clock">
                      {(c.after ?? c.before)?.summary
                        ? (c.after ?? c.before)!.summary
                        : '（无标题）'}
                    </div>
                  </td>
                  <td>
                    {primary === 'added' && c.after && (
                      <SideSummary inst={c.after} side="after" onPick={() => pick('after')} />
                    )}
                    {primary === 'removed' && c.before && (
                      <SideSummary inst={c.before} side="before" onPick={() => pick('before')} />
                    )}
                    {primary !== 'added' && primary !== 'removed' && (
                      <div className="diff-fields">
                        {c.fields.map((f) => (
                          <div className="diff-line" key={f.kind}>
                            <span className={`kind-badge ${f.kind}`}>{f.label}</span>
                            <span
                              className="val before"
                              title="点击定位变更前实例与 ICS 源码"
                              onClick={(e) => {
                                e.stopPropagation();
                                pick('before');
                              }}
                            >
                              {f.before}
                            </span>
                            <span className="diff-arrow">→</span>
                            <span
                              className="val after"
                              title="点击定位变更后实例与 ICS 源码"
                              onClick={(e) => {
                                e.stopPropagation();
                                pick('after');
                              }}
                            >
                              {f.after}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function SideSummary({
  inst,
  side,
  onPick,
}: {
  inst: NonNullable<ImpactChange['before']>;
  side: 'before' | 'after';
  onPick: () => void;
}) {
  return (
    <div className={`diff-side ${side}`} onClick={(e) => { e.stopPropagation(); onPick(); }}>
      <div className="diff-line">
        <span className="val">{rangeText(inst)}</span>
      </div>
      <div className="diff-line">
        <span className="diff-field-name">地点</span>
        <span className="val">{orEmpty(inst.location, 'location')}</span>
      </div>
      <div className="diff-line">
        <span className="diff-field-name">标题</span>
        <span className="val">{orEmpty(inst.summary, 'summary')}</span>
      </div>
      <div className="diff-line">
        <span className="diff-field-name">状态</span>
        <span className="val">{inst.status || 'CONFIRMED'}</span>
      </div>
    </div>
  );
}
