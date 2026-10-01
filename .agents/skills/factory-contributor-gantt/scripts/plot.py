#!/usr/bin/env python3
"""Render sanitized contributor timing as static SVG and PNG with Matplotlib."""
import argparse
import json
import math
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.ticker import FuncFormatter, MultipleLocator

COLORS = {'output-item': '#d97706', 'tool': '#64748b', 'wait': '#7c3aed',
          'subprocess': '#2563eb', 'routing': '#0891b2', 'unknown': '#cbd5e1'}
LABELS = {'output-item': 'Observed Reasoning / AgentMessage output items',
          'tool': 'Agent tool request → result', 'wait': 'Explicit waits / polls',
          'subprocess': 'Script subprocesses (direct executables)',
          'routing': 'Observed routing + scheduling', 'unknown': 'Unclassified gaps'}


def plot(data, output):
    rows = data['intervals']
    agents = data['agents']
    # Rows follow manifest agent order; declare parent identities in each heading.
    lanes = []
    for agent in agents:
        lanes.append((agent['id'], 'heading', agent['id'] + (' ← parent ' + agent['parent'] if agent.get('parent') else ' · coordinator')))
        lanes.extend((agent['id'], kind, LABELS[kind]) for kind in COLORS)
    details = [(a['id'], list(dict.fromkeys(r['label'] for r in rows if r['agent'] == a['id'] and r['kind'] == 'subprocess'))) for a in agents]
    panels = [d for d in details if d[1]]
    overview_height = max(5, len(lanes)*.31)
    detail_height = max([3] + [len(labels)*.28+1 for _,labels in panels])
    fig = plt.figure(figsize=(20, overview_height+detail_height+3), facecolor='#f8fafc')
    grid = fig.add_gridspec(2 if panels else 1, 1, height_ratios=[overview_height, detail_height] if panels else [overview_height], hspace=.5)
    ax = fig.add_subplot(grid[0])
    for i, (agent, kind, label) in enumerate(lanes):
        if kind == 'heading':
            ax.axhspan(i-.5, i+.5, color='#e2e8f0')
            continue
        for row in rows:
            if row['agent'] == agent and row['kind'] == kind:
                ax.broken_barh([(row['start'], row['end']-row['start'])], (i-.3, .6), facecolors=COLORS[kind], hatch='////' if kind == 'unknown' else None)
    ax.set_yticks(range(len(lanes)), [r[2] for r in lanes], fontsize=10)
    ax.set_ylim(len(lanes)-.5, -.6)
    clock = FuncFormatter(lambda value, _: f'{int(value)//60}:{int(value)%60:02d}')
    ax.xaxis.set_major_formatter(clock)
    ax.set_xlim(0, data['elapsedSeconds']*1.03)
    ax.grid(axis='x', alpha=.3)
    ax.set_xlabel('Elapsed wall clock · minutes:seconds; lanes overlap')
    for index, marker in enumerate(data['markers']):
        ax.axvline(marker['at'], color='#15803d', linestyle='--', linewidth=1)
        ax.annotate(marker['label'], xy=(marker['at'], 1), xycoords=('data', 'axes fraction'), xytext=(0, 15+14*(index%3)), textcoords='offset points', ha='center', fontsize=9, color='#15803d')
    if panels:
        detail_grid = grid[1].subgridspec(1, len(panels), wspace=.8)
        for index, (agent, labels) in enumerate(panels):
            detail = fig.add_subplot(detail_grid[index])
            for i, label in enumerate(labels):
                chosen = [r for r in rows if r['agent'] == agent and r['kind'] == 'subprocess' and r['label'] == label]
                for row in chosen:
                    detail.broken_barh([(row['start'], row['end']-row['start'])], (i-.3, .6), facecolors=COLORS['subprocess'])
                total = sum(r['end']-r['start'] for r in chosen)
                detail.text(max(r['end'] for r in chosen), i, f' {total:.2f}s', va='center', fontsize=8)
            relevant = [r for r in rows if r['agent'] == agent and r['kind'] == 'subprocess']
            lo, hi = min(r['start'] for r in relevant), max(r['end'] for r in relevant)
            detail.set_xlim(lo, hi+max(1, (hi-lo)*.2))
            detail.set_ylim(len(labels)-.5, -.6)
            detail.set_yticks(range(len(labels)), labels, fontsize=9)
            detail.xaxis.set_major_formatter(clock)
            detail.xaxis.set_major_locator(MultipleLocator(max(1, math.ceil((hi-lo)/6))))
            detail.grid(axis='x', alpha=.3)
            detail.set_title(f'{agent} · grouped script subprocess detail', fontsize=11)
            detail.set_xlabel('Same elapsed clock; zoomed scale')
    fig.suptitle(f"{data['title']}\nSelected window {data['elapsedSeconds']:.3f}s · {data['startUtc']} → {data['endUtc']}", fontsize=17, y=.98)
    fig.legend(handles=[Patch(facecolor=COLORS[k], label=LABELS[k]) for k in COLORS], loc='lower center', bbox_to_anchor=(.5, .075), ncol=2, fontsize=9)
    fig.text(.025, .025, '\n'.join(data['limitations']), fontsize=9, color='#475569')
    fig.subplots_adjust(left=.28, right=.96, top=.85, bottom=.19)
    output.mkdir(parents=True, exist_ok=True)
    for extension in ('svg', 'png'):
        fig.savefig(output / f'gantt.{extension}', dpi=150)
    plt.close(fig)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('timing', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    plot(json.loads(args.timing.read_text()), args.output)
    print('Saved gantt.svg and gantt.png')
