import type { RouteStop } from '../lib/types';

/** Schematic warehouse map: aisles as lanes, the planned stops numbered in walking order. */
export function RouteMap({ stops, done }: { stops: RouteStop[]; done: Set<string> }) {
  if (stops.length === 0) return null;
  const aisles = Math.max(...stops.map((s) => s.aisle), 0) + 1;
  const length = Math.max(...stops.map((s) => s.pos), 10);
  const W = Math.max(aisles, 3) * 60 + 40;
  const H = 260;
  const x = (a: number) => 30 + a * 60;
  const y = (p: number) => 20 + (p / length) * (H - 50);
  const pts = [{ aisle: 0, pos: 0 }, ...stops, { aisle: 0, pos: 0 }];
  return (
    <figure className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-64 min-w-full"
        role="img"
        aria-label={`Route with ${stops.length} stops`}
      >
        {Array.from({ length: Math.max(aisles, 3) }, (_, a) => (
          <g key={a}>
            <rect x={x(a) - 9} y={14} width={18} height={H - 38} rx={4} fill="#e2e8f0" />
            <text x={x(a)} y={H - 6} textAnchor="middle" fontSize="11" fill="#475569">
              A{a}
            </text>
          </g>
        ))}
        <polyline
          points={pts.map((p) => `${x(p.aisle)},${y(p.pos)}`).join(' ')}
          fill="none"
          stroke="#0f766e"
          strokeWidth={2}
          strokeDasharray="5 4"
        />
        <circle cx={x(0)} cy={y(0)} r={7} fill="#fbbf24" />
        {stops.map((s) => (
          <g key={s.orderLineId}>
            <circle
              cx={x(s.aisle)}
              cy={y(s.pos)}
              r={11}
              fill={done.has(s.orderLineId) ? '#059669' : s.zone === 'ambient' ? '#0f766e' : '#0284c7'}
            />
            <text
              x={x(s.aisle)}
              y={y(s.pos) + 4}
              textAnchor="middle"
              fontSize="11"
              fontWeight="700"
              fill="white"
            >
              {s.sequence}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-500">
        Schematic: start/hand-off at the yellow marker; blue stops are temperature-controlled items.
      </figcaption>
    </figure>
  );
}
