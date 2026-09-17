import { useCallback, useMemo, useRef, useState } from 'react';
import { parseCalendar } from './ical-engine/parser';
import { expandAll } from './ical-engine/expansion';
import { detectConflicts, instanceId } from './ical-engine/conflicts';
import { diffInstances } from './ical-engine/impact';
import { normalizeCalendar } from './ical-engine/normalizer';
import { SAMPLE_ICS } from './ical-engine/samples';
import type {
  Instance,
  MasterSeries,
  OverrideEvent,
  ParsedCalendar,
  Warning,
} from './ical-engine/types';
import type { ImpactChange } from './ical-engine/impact';
import { SourceView } from './components/SourceView';
import { InstanceTable } from './components/InstanceTable';
import type { AuditTab } from './components/InstanceTable';
import { ImpactView } from './components/ImpactView';
import { SeriesPanel } from './components/SeriesPanel';
import { addDays, downloadText, localMidnightUtcSec, ymd } from './utils/format';

type ParseOutcome =
  | ({ ok: true } & ParsedCalendar)
  | { ok: false; fatal: string; warnings: Warning[]; logicalLines: string[] };

type RightTab = AuditTab | 'impact';

interface Selection {
  instanceKey: string | null;
  seriesId: string | null;
  overrideId: string | null;
  /** 变更影响视图当前选中的身份（uid#recurKey） */
  impactId: string | null;
  /** 差异项选择的是变更前还是变更后（影响源码定位行） */
  impactSide: 'before' | 'after' | null;
  /** 源码高亮的附加块（冲突方） */
  conflictRanges: { start: number; end: number; kind: 'conflict' }[];
  focusLine?: number;
  token: string;
}

const EMPTY_SELECTION: Selection = {
  instanceKey: null,
  seriesId: null,
  overrideId: null,
  impactId: null,
  impactSide: null,
  conflictRanges: [],
  token: '',
};

export default function App() {
  const [raw, setRaw] = useState<string>(SAMPLE_ICS);
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 示例范围覆盖 2026-03 ~ 2026-04
  const today = ymd(new Date());
  const [startDate, setStartDate] = useState('2026-02-25');
  const [endDate, setEndDate] = useState('2026-04-15');

  const [disabledOverrides, setDisabledOverrides] = useState<Set<string>>(new Set());
  const [editedRrule, setEditedRrule] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [rightTab, setRightTab] = useState<RightTab>('visible');

  const reparse = useCallback((text: string): ParseOutcome => {
    const result = parseCalendar(text);
    let next: ParseOutcome;
    if ('fatal' in result) {
      next = {
        ok: false,
        fatal: result.fatal,
        warnings: [],
        logicalLines: text.replace(/\r\n/g, '\n').split('\n'),
      };
    } else {
      next = { ok: true, ...result };
    }
    setOutcome(next);
    setDisabledOverrides(new Set());
    setEditedRrule({});
    setSelection(EMPTY_SELECTION);
    return next;
  }, []);

  // 初次挂载解析示例
  const didInit = useRef(false);
  if (!didInit.current) {
    didInit.current = true;
    setOutcome(parseWith(SAMPLE_ICS));
  }

  const range = useMemo(() => {
    const startUtc = localMidnightUtcSec(startDate);
    const endUtc = localMidnightUtcSec(addDays(endDate, 1));
    if (Number.isNaN(startUtc) || Number.isNaN(endUtc)) return null;
    return { startUtc, endUtc };
  }, [startDate, endDate]);

  const expansion = useMemo(() => {
    if (!outcome?.ok || !range) return null;
    return expandAll(outcome.masters, range, { disabledOverrides, editedRrule });
  }, [outcome, range, disabledOverrides, editedRrule]);

  // 变更影响的基线：原始日历在相同范围内的生效实例（无规则编辑、无例外停用）
  const baseline = useMemo(() => {
    if (!outcome?.ok || !range) return null;
    return expandAll(outcome.masters, range, {
      disabledOverrides: new Set<string>(),
      editedRrule: {},
    });
  }, [outcome, range]);

  // 重新解析、调整日期范围、编辑规则或停用例外后立即重算
  const impact = useMemo(
    () => (baseline && expansion ? diffInstances(baseline.instances, expansion.instances) : null),
    [baseline, expansion]
  );

  const conflicts = useMemo(
    () => (expansion ? detectConflicts(expansion.instances) : null),
    [expansion]
  );

  const allWarnings = useMemo(() => {
    if (!outcome) return [] as Warning[];
    const base = outcome.warnings;
    const extra = expansion?.warnings ?? [];
    return [...base, ...extra];
  }, [outcome, expansion]);

  const selectedInstance = useMemo<Instance | null>(() => {
    if (!selection.instanceKey) return null;
    const find = (e: typeof expansion): Instance | null =>
      e
        ? e.instances.find((i) => instanceId(i) === selection.instanceKey) ??
          e.cancelled.find((i) => instanceId(i) === selection.instanceKey) ??
          e.excluded.find((i) => instanceId(i) === selection.instanceKey) ??
          null
        : null;
    // 差异项“变更前”可能与“变更后”同 instanceId（如停用 CANCELLED 后原实例恢复），
    // 此时必须优先取基线对象，源码定位行才指向 RECURRENCE-ID 块
    if (selection.impactSide === 'before') return find(baseline) ?? find(expansion);
    return find(expansion) ?? find(baseline);
  }, [expansion, baseline, selection]);

  // ---------- 交互 ----------

  const selectInstance = useCallback(
    (
      inst: Instance,
      impactIdentity: string | null = null,
      impactSide: 'before' | 'after' | null = null
    ) => {
      const peers = conflicts?.byKey.get(instanceId(inst)) ?? [];
      setSelection({
        instanceKey: instanceId(inst),
        seriesId: inst.seriesId,
        overrideId: inst.override?.id ?? null,
        impactId: impactIdentity,
        impactSide,
        conflictRanges: peers.map((p) => ({
          start: p.overrideRange?.start ?? p.masterRange.start,
          end: p.overrideRange?.end ?? p.masterRange.end,
          kind: 'conflict' as const,
        })),
        token: `inst-${instanceId(inst)}`,
      });
    },
    [conflicts]
  );

  // 变更影响视图点击差异项：联动实例表页签与 ICS 源码定位
  const selectImpactChange = useCallback(
    (side: 'before' | 'after', change: ImpactChange) => {
      const inst = side === 'after' ? change.after : change.before;
      if (!inst) return;
      // 候选侧实例在当前生效/取消/排除列表中时切到对应页签并选中；
      // 变更前（尤其被规则裁掉的实例）不在当前实例表中时保持在变更影响页，仅联动源码
      if (side === 'after') {
        const inList = (list: Instance[]): boolean =>
          list.some((i) => instanceId(i) === instanceId(inst));
        if (expansion && inList(expansion.instances)) setRightTab('visible');
        else if (expansion && inList(expansion.cancelled)) setRightTab('cancelled');
        else if (expansion && inList(expansion.excluded)) setRightTab('excluded');
      }
      selectInstance(inst, change.id, side);
    },
    [expansion, selectInstance]
  );

  const focusSeries = useCallback((m: MasterSeries) => {
    setSelection({
      instanceKey: null,
      seriesId: m.id,
      overrideId: null,
      impactId: null,
      impactSide: null,
      conflictRanges: [],
      token: `series-${m.id}-${Date.now()}`,
    });
  }, []);

  const focusOverride = useCallback((ov: OverrideEvent) => {
    setSelection((prev) => ({
      instanceKey: prev.instanceKey,
      seriesId: ov.id.split('#')[0],
      overrideId: ov.id,
      impactId: null,
      impactSide: null,
      conflictRanges: [],
      token: `ov-${ov.id}`,
    }));
  }, []);

  const toggleOverride = useCallback((id: string) => {
    setDisabledOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const editRrule = useCallback((seriesId: string, value: string) => {
    setEditedRrule((prev) => ({ ...prev, [seriesId]: value }));
  }, []);

  const resetRrule = useCallback((seriesId: string) => {
    setEditedRrule((prev) => {
      const next = { ...prev };
      delete next[seriesId];
      return next;
    });
  }, []);

  const onImportFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setRaw(text);
      reparse(text);
    };
    reader.readAsText(file);
  };

  const onExport = (): void => {
    if (!outcome?.ok) return;
    const { ics } = normalizeCalendar(outcome, { disabledOverrides, editedRrule });
    downloadText('normalized.ics', ics);
  };

  const onCopyExport = async (): Promise<void> => {
    if (!outcome?.ok) return;
    const { ics } = normalizeCalendar(outcome, { disabledOverrides, editedRrule });
    await navigator.clipboard.writeText(ics);
  };

  // ---------- 源码高亮参数 ----------

  const sourceProps = useMemo(() => {
    if (!selectedInstance) return {};
    return {
      masterRange: selectedInstance.masterRange,
      originLine: selection.focusLine ?? selectedInstance.originLine,
      overrideRange: selectedInstance.overrideRange,
      highlightRanges: selection.conflictRanges,
    };
  }, [selectedInstance, selection]);

  const seriesSourceProps = useMemo(() => {
    if (!outcome?.ok || !selection.seriesId) return {};
    const m = outcome.masters.find((x) => x.id === selection.seriesId);
    if (!m) return {};
    const ov = m.overrides.find((o) => o.id === selection.overrideId);
    return {
      masterRange: m.block.range,
      originLine:
        selection.focusLine ??
        (ov
          ? ov.block.propLines['RECURRENCE-ID']?.[0] ?? m.block.range.start
          : m.rruleLine || m.block.propLines['DTSTART']?.[0]),
      overrideRange: ov?.block.range,
      highlightRanges: [] as { start: number; end: number; kind: 'conflict' }[],
    };
  }, [outcome, selection]);

  const logicalLines = outcome?.logicalLines ?? raw.replace(/\r\n/g, '\n').split('\n');
  const activeSource = selectedInstance ? sourceProps : seriesSourceProps;

  return (
    <div className="app">
      <header className="app-header">
        <h1>📅 iCalendar 重复日程校验台</h1>
        <span className="sub">本地运行 · DTSTART / RRULE / RDATE / EXDATE / RECURRENCE-ID 展开与校验</span>
        <span className="spacer" />
        <button onClick={() => fileRef.current?.click()}>导入 .ics</button>
        <input
          ref={fileRef}
          type="file"
          accept=".ics,text/calendar"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportFile(f);
            e.target.value = '';
          }}
        />
        <button onClick={() => { setRaw(SAMPLE_ICS); reparse(SAMPLE_ICS); }}>载入示例</button>
        <button onClick={() => setRaw('')}>清空</button>
        <button className="primary" onClick={onExport} disabled={!outcome?.ok}>
          导出规范化 ICS
        </button>
        <button className="ghost" onClick={onCopyExport} disabled={!outcome?.ok}>
          复制 ICS
        </button>
      </header>

      <div className="main">
        {/* 左：输入 + 告警 + 源码 */}
        <section className="pane">
          <div className="pane-title">ICS 输入 / 原始行定位</div>
          <div className="input-toolbar">
            <button className="primary" onClick={() => reparse(raw)}>
              解析并展开
            </button>
            <span style={{ flex: 1 }} />
            {outcome && (
              <span
                className={outcome.ok ? 'rrule-ok' : 'rrule-error'}
                style={{ fontSize: 12 }}
              >
                {outcome.ok
                  ? `✓ ${outcome.masters.length} 个事件序列 / ${logicalLines.length} 行`
                  : `✕ ${outcome.fatal}`}
              </span>
            )}
          </div>
          <textarea
            className="ics-input"
            spellCheck={false}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="在此粘贴 BEGIN:VCALENDAR ……"
          />

          <div className="range-bar">
            <b>展开范围</b>
            <label>
              起 <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label>
              止 <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <span className="range-presets">
              <button
                onClick={() => {
                  setStartDate(addDays(today, -14));
                  setEndDate(addDays(today, 90));
                }}
              >
                近 3 月
              </button>
              <button
                onClick={() => {
                  setStartDate(addDays(today, -180));
                  setEndDate(addDays(today, 180));
                }}
              >
                ±半年
              </button>
            </span>
            {range && range.startUtc >= range.endUtc && (
              <span className="rrule-error" style={{ fontSize: 12 }}>
                起始日期必须早于结束日期
              </span>
            )}
            <span className="spacer" style={{ flex: 1 }} />
            {expansion && (
              <span className="stats">
                <span>
                  生效 <b>{expansion.instances.length}</b>
                </span>
                <span>
                  取消 <b>{expansion.cancelled.length}</b>
                </span>
                <span>
                  排除 <b>{expansion.excluded.length}</b>
                </span>
                <span>
                  冲突组 <b style={{ color: 'var(--conflict)' }}>{conflicts?.groups.length ?? 0}</b>
                </span>
              </span>
            )}
          </div>

          {allWarnings.length > 0 && (
            <div className="warnings">
              {allWarnings.map((w) => (
                <div className="warning-item" key={w.id}>
                  <span className={`wlevel ${w.level}`}>
                    {w.level === 'error' ? '错误' : w.level === 'warn' ? '警告' : '提示'}
                  </span>
                  <span>{w.text}</span>
                  {w.line && (
                    <span
                      className="wline"
                      onClick={() =>
                        setSelection((p) => ({
                          ...p,
                          focusLine: w.line,
                          instanceKey: null,
                          token: `warn-${w.id}`,
                        }))
                      }
                    >
                      → L{w.line}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <SourceView
            lines={logicalLines}
            scrollToken={selection.token}
            focusLine={selection.focusLine}
            {...activeSource}
          />
        </section>

        {/* 中：规则与例外 */}
        <section className="pane">
          <div className="pane-title">重复规则 / 例外管理</div>
          {outcome?.ok ? (
            <SeriesPanel
              masters={outcome.masters}
              disabledOverrides={disabledOverrides}
              editedRrule={editedRrule}
              rruleErrors={expansion?.rruleErrors ?? {}}
              selectedSeriesId={selection.seriesId}
              selectedOverrideId={selection.overrideId}
              onFocusSeries={focusSeries}
              onFocusOverride={focusOverride}
              onToggleOverride={toggleOverride}
              onEditRrule={editRrule}
              onResetRrule={resetRrule}
            />
          ) : (
            <div className="empty-hint">
              {outcome && !outcome.ok ? outcome.fatal : '点击“解析并展开”开始校验'}
            </div>
          )}
        </section>

        {/* 右：实例、变更影响与冲突 */}
        <section className="pane">
          <div className="pane-title">实例列表 / 变更影响 / LOCATION 冲突</div>
          {expansion ? (
            <>
              <div className="tabs">
                <button
                  className={rightTab === 'visible' ? 'active' : ''}
                  onClick={() => setRightTab('visible')}
                >
                  生效实例（{expansion.instances.length}）
                </button>
                <button
                  className={rightTab === 'cancelled' ? 'active' : ''}
                  onClick={() => setRightTab('cancelled')}
                >
                  已取消（{expansion.cancelled.length}）
                </button>
                <button
                  className={rightTab === 'excluded' ? 'active' : ''}
                  onClick={() => setRightTab('excluded')}
                >
                  已排除（{expansion.excluded.length}）
                </button>
                <button
                  className={rightTab === 'impact' ? 'active' : ''}
                  onClick={() => setRightTab('impact')}
                  title="比较原始日历与规则编辑、例外停用后的生效实例"
                >
                  变更影响（{impact?.length ?? 0}）
                </button>
              </div>
              {rightTab === 'impact' && impact ? (
                <ImpactView
                  changes={impact}
                  selectedId={selection.impactId}
                  onSelect={selectImpactChange}
                />
              ) : (
                <InstanceTable
                  tab={rightTab === 'impact' ? 'visible' : rightTab}
                  instances={expansion.instances}
                  cancelled={expansion.cancelled}
                  excluded={expansion.excluded}
                  selectedKey={selection.instanceKey}
                  onSelect={(inst) => selectInstance(inst)}
                />
              )}
            </>
          ) : (
            <div className="empty-hint">
              {outcome && !outcome.ok ? '解析失败，请修正左侧输入' : '暂无展开结果'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function parseWith(text: string): ParseOutcome {
  const result = parseCalendar(text);
  if ('fatal' in result) {
    return {
      ok: false,
      fatal: result.fatal,
      warnings: [],
      logicalLines: text.replace(/\r\n/g, '\n').split('\n'),
    };
  }
  return { ok: true, ...result };
}
