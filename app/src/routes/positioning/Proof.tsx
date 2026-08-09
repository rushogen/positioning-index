/**
 * Finding 4 — the kinds of proof companies put on the page. A grouped bar (ECharts)
 * contrasts how many companies use each kind of claim against how many such claims
 * they make, so the gap (claims per company) is visible. Tiny kinds dropped.
 */
import type { Positioning } from '../../lib/types';
import { Chip, Chips, Disclosure, Stat } from '../../components/ui';
import { dense, droppedNote } from '../../lib/filter';
import { Finding, CompanyList } from './parts';
import { useChart, prefersReduced } from './util';

export function Proof({ data }: { data: Positioning['proof_claims'] }) {
  const of = data.coverage.readable;
  const d = dense(data.kinds, (k) => k.n);
  const kinds = d.kept;
  const top = [...kinds].sort((a, b) => b.claims - a.claims)[0];
  // ECharts draws bottom-up, so reverse to read most-claimed at the top.
  const rows = [...kinds].sort((a, b) => a.claims - b.claims);

  const ref = useChart((chart, t) => {
    chart.setOption({
      animation: !prefersReduced(),
      animationDuration: 700,
      grid: { left: 4, right: 16, top: 34, bottom: 4, containLabel: true },
      legend: {
        data: ['Companies', 'Claims'], top: 0, right: 0,
        textStyle: { color: t.ink2, fontFamily: 'Roboto', fontSize: 12 },
        itemWidth: 12, itemHeight: 12, itemGap: 16,
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: t.panel, borderColor: t.rule,
        textStyle: { color: t.ink, fontFamily: 'Roboto', fontSize: 13 },
      },
      xAxis: {
        type: 'value',
        axisLabel: { color: t.ink3, fontFamily: 'Roboto', fontSize: 11 },
        splitLine: { lineStyle: { color: t.rule } },
        axisLine: { show: false }, axisTick: { show: false },
      },
      yAxis: {
        type: 'category',
        data: rows.map((k) => k.label),
        axisLabel: { color: t.ink, fontFamily: 'Roboto', fontSize: 13 },
        axisLine: { lineStyle: { color: t.rule } }, axisTick: { show: false },
      },
      series: [
        {
          name: 'Companies', type: 'bar',
          data: rows.map((k) => k.n),
          itemStyle: { color: t.accent, borderRadius: [0, 3, 3, 0] },
          barGap: '10%', barWidth: '32%',
          label: { show: true, position: 'right', color: t.ink2, fontFamily: 'Roboto', fontSize: 11 },
        },
        {
          name: 'Claims', type: 'bar',
          data: rows.map((k) => k.claims),
          itemStyle: { color: t.accent2, borderRadius: [0, 3, 3, 0] },
          barWidth: '32%',
          label: { show: true, position: 'right', color: t.ink2, fontFamily: 'Roboto', fontSize: 11 },
        },
      ],
    });
  }, [data]);

  return (
    <Finding n="03" kicker="The proof they show" title={<>Percentages, more than anything</>}>
      <div className="lead">
        <Stat tone="green" figure={data.total_claims} unit={<>quantified claims counted across {of} readable pages</>} />
        <div className="lead-copy">
          <p>
            {top && <>“{top.label}” is the most common kind — {top.n} of {of} pages carry one, and between them they
            make {top.claims} such claims.</>} Percentage gains and raw counts do most of the work; time-to-result
            claims are rare.
          </p>
          <Chips>
            <Chip tone="measured">measured</Chip>
            <Chip tone="coverage">{of} of {data.coverage.tracked} readable</Chip>
          </Chips>
        </div>
      </div>

      <div className="viz chart-wrap">
        <div ref={ref} className="echart" style={{ height: `${rows.length * 54 + 44}px` }} />
      </div>
      {droppedNote(d) && <p className="drop-note">{droppedNote(d, 'kinds')}.</p>}

      <Disclosure summary="Each kind and the companies that use it">
        {[...kinds].sort((a, b) => b.claims - a.claims).map((k) => (
          <div key={k.key} className="disc-group">
            <p className="disc-group-head"><b>{k.label}</b> · {k.n} companies, {k.claims} claims{k.note && <> · e.g. {k.note}</>}</p>
            <CompanyList companies={k.companies} />
          </div>
        ))}
      </Disclosure>
    </Finding>
  );
}
