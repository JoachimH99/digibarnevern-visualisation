import { useEffect, useReducer, useRef, useState } from 'react'

type Pt = [number, number]
type Side = 'A' | 'B'
type Packet = {
  id: number
  t0: number
  path: Pt[]
  colors: string[]
  procSeg: number // first segment after processing
  speed?: number
  side?: Side
  replay?: boolean
  thumb?: boolean // gives a thumbs up when it passes processing
  thumbed?: boolean
  latched?: string
}

const BLUE = '#3b82f6'
const GREEN = '#22c55e'
const SPEED = 170
const REPLAY_SPEED = 450
const BUCKET_MAX = 16

const F: Pt = [100, 280]
const SA: Pt = [300, 280] // Storage API
const BUCKET: Pt = [500, 280]
const PX = 600
const BEND_X = 730
const DB_X = 900
const READ_X = 1100
const Y: Record<Side, number> = { A: 100, B: 460 }
const END: Record<Side, Pt> = { A: [850, Y.A], B: [850, Y.B] }
const PROC: Record<Side, Pt> = { A: [PX, Y.A], B: [PX, Y.B] }
const CORNER: Record<Side, Pt> = { A: [SA[0], Y.A], B: [SA[0], Y.B] }
// Distance along a branch path (from Fiks) to the processing node
const PROC_DIST = SA[0] - F[0] + Math.abs(Y.A - SA[1]) + (PX - SA[0])

const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])

function branchPath(start: Pt, side: Side): Pt[] {
  return [start, SA, CORNER[side], PROC[side], [BEND_X, Y[side]], END[side]]
}

function locate(p: Packet, now: number) {
  let d = ((now - p.t0) / 1000) * (p.speed ?? SPEED)
  if (d < 0) return null
  for (let i = 0; i < p.path.length - 1; i++) {
    const l = len(p.path[i], p.path[i + 1])
    if (d <= l) {
      const k = d / l
      if (i >= p.procSeg && p.latched === undefined) p.latched = BLUE
      return {
        x: p.path[i][0] + (p.path[i + 1][0] - p.path[i][0]) * k,
        y: p.path[i][1] + (p.path[i + 1][1] - p.path[i][1]) * k,
        color: i >= p.procSeg ? p.latched! : p.colors[i],
      }
    }
    d -= l
  }
  return 'done' as const
}

export default function SciFiReplay() {
  const [bucket, setBucket] = useState(8)
  const [sent, setSent] = useState(0)
  const [dbAItems, setDbAItems] = useState<string[]>([])
  const [dbBItems, setDbBItems] = useState<string[]>([])
  const [downA, setDownA] = useState(false)
  const [downB, setDownB] = useState(false)
  const [readTarget, setReadTarget] = useState<Side>('A')
  const [seqRocket, setSeqRocket] = useState<{ key: number; y: number } | null>(null)
  const [, tick] = useReducer((n: number) => n + 1, 0)

  const packets = useRef<Packet[]>([])
  const falling = useRef<{ id: number; color: string; t0: number; y: number }[]>([])
  const thumbs = useRef<{ id: number; side: Side; t0: number }[]>([])
  const nextId = useRef(0)
  const activeRef = useRef<Side>('A') // branch that receives live submissions
  const downRef = useRef<Record<Side, boolean>>({ A: false, B: false })
  const replayingRef = useRef(false)
  const targetRef = useRef<Side>('B')
  const sentRef = useRef(0)
  const bucketRef = useRef(8)
  bucketRef.current = bucket

  // Looping sequence: destroy the inactive DB, replay into it, then swap
  useEffect(() => {
    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number) =>
      new Promise<void>((res) => {
        timers.push(window.setTimeout(res, ms))
      })
    const waitUntil = async (cond: () => boolean) => {
      while (!cancelled && !cond()) await wait(50)
    }
    const setDown = (t: Side, v: boolean) => {
      downRef.current[t] = v
      if (t === 'A') setDownA(v)
      else setDownB(v)
    }
    let rocketKey = 0
    const destroy = async (t: Side) => {
      await wait(1000) // delay before the rocket launches
      if (cancelled) return
      setSeqRocket({ key: ++rocketKey, y: Y[t] })
      await wait(600)
      if (cancelled) return
      setDown(t, true)
      if (t === 'A') setDbAItems([])
      else setDbBItems([])
      await wait(300)
      setSeqRocket(null)
    }

    const run = async () => {
      setDbAItems(Array(12).fill(BLUE))
      setDbBItems(Array(12).fill(BLUE))
      setDown('A', false)
      setDown('B', false)
      activeRef.current = 'A'
      setReadTarget('A')
      sentRef.current = 0
      setSent(0)
      await wait(2500)
      while (!cancelled) {
        const t: Side = activeRef.current === 'A' ? 'B' : 'A' // the inactive branch
        // 1. Destroy the inactive DB
        await destroy(t)
        if (cancelled) return
        // 2. Replay bucket -> storage API -> inactive branch
        setDown(t, false)
        targetRef.current = t
        sentRef.current = 0
        setSent(0)
        replayingRef.current = true
        await waitUntil(() => sentRef.current >= bucketRef.current && !packets.current.some((p) => p.replay))
        replayingRef.current = false
        if (cancelled) return
        // 3. Swap: the replayed DB becomes active and the Read API follows
        activeRef.current = t
        setReadTarget(t)
        await wait(4000)
      }
    }
    run()

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
      replayingRef.current = false
      setSeqRocket(null)
    }
  }, [])

  // Emitters
  useEffect(() => {
    const emitFiks = () => {
      const t0 = performance.now()
      // Passes through the storage API to the bucket...
      packets.current.push({ id: nextId.current++, t0, path: [F, SA, BUCKET], colors: [BLUE, BLUE], procSeg: 99 })
      // ...and to the active branch
      const side = activeRef.current
      packets.current.push({
        id: nextId.current++,
        t0,
        side,
        path: branchPath(F, side),
        colors: [BLUE, BLUE, BLUE],
        procSeg: 3,
        thumb: true,
      })
    }
    const emitReplay = () => {
      if (replayingRef.current && sentRef.current < bucketRef.current) {
        const side = targetRef.current
        packets.current.push({
          id: nextId.current++,
          t0: performance.now(),
          side,
          replay: true,
          path: branchPath(BUCKET, side),
          colors: [BLUE, BLUE, BLUE],
          procSeg: 3,
          speed: REPLAY_SPEED,
        })
        sentRef.current++
        setSent(sentRef.current)
      }
    }
    emitFiks()
    const i1 = setInterval(emitFiks, 1100)
    const i2 = setInterval(emitReplay, 1100 / 3 / (REPLAY_SPEED / SPEED))
    return () => {
      clearInterval(i1)
      clearInterval(i2)
    }
  }, [])

  // Animation loop
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const now = performance.now()
      const keep: Packet[] = []
      for (const p of packets.current) {
        if (p.thumb && !p.thumbed && ((now - p.t0) / 1000) * (p.speed ?? SPEED) >= PROC_DIST) {
          p.thumbed = true
          thumbs.current.push({ id: nextId.current++, side: p.side!, t0: now })
        }
        const r = locate(p, now)
        if (r === 'done') {
          const end = p.path[p.path.length - 1]
          const c = p.latched ?? p.colors[p.colors.length - 1]
          if (end === END.A || end === END.B) {
            const side: Side = end === END.A ? 'A' : 'B'
            if (downRef.current[side]) {
              falling.current.push({ id: nextId.current++, color: c, t0: now, y: end[1] })
            } else {
              const add = (x: string[]) => [...x, c].slice(-12)
              if (side === 'A') setDbAItems(add)
              else setDbBItems(add)
            }
          } else if (end === BUCKET) setBucket((n) => Math.min(n + 1, BUCKET_MAX))
        } else keep.push(p)
      }
      packets.current = keep
      falling.current = falling.current.filter((f) => now - f.t0 < 1200)
      thumbs.current = thumbs.current.filter((t) => now - t.t0 < 1000)
      tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const now = performance.now()
  const readY = Y[readTarget]
  const edge = (s: Side) => `M${SA} L${CORNER[s]} L${BEND_X},${Y[s]} L${END[s]}`

  return (
    <svg viewBox="0 0 1200 580">
      {/* edges */}
      <path className="edge" d={`M${F} L${SA}`} />
      <path className="edge" d={`M${SA} L${BUCKET}`} />
      <path className="edge" d={edge('A')} />
      <path className="edge" d={edge('B')} />

      {/* packets */}
      {packets.current.map((p) => {
        const r = locate(p, now)
        if (!r || r === 'done') return null
        return <circle key={p.id} cx={r.x} cy={r.y} r={9} fill={r.color} />
      })}

      {/* falling balls */}
      {falling.current.map((f) => {
        const t = Math.max(0, (now - f.t0) / 1000)
        return <circle key={f.id} cx={850 + 25 * t} cy={f.y + 700 * t * t} r={9} fill={f.color} opacity={Math.max(0, 1 - t / 1.2)} />
      })}

      {/* thumbs up above processing */}
      {thumbs.current.map((t) => {
        const k = (now - t.t0) / 1000
        return (
          <text
            key={t.id}
            x={PX}
            y={Y[t.side] - 60 - 30 * k}
            opacity={Math.max(0, 1 - k)}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: 30 }}
          >
            👍
          </text>
        )
      })}

      {/* Fiks */}
      <g className="node" transform={`translate(${F[0] - 60} ${F[1] - 35})`}>
        <rect width="120" height="70" rx="8" />
        <text x="60" y="41">Fiks IO</text>
      </g>

      {/* Storage API */}
      <g className="node" transform={`translate(${SA[0] - 60} ${SA[1] - 35})`}>
        <rect width="120" height="70" rx="8" />
        <text x="60" y="41">Storage API</text>
      </g>

      {/* Processing x2 */}
      {(['A', 'B'] as const).map((s) => (
        <g key={s} className="node" transform={`translate(${PX - 60} ${Y[s] - 35})`}>
          <rect width="120" height="70" rx="8" />
          <text x="60" y="41">Prosessering</text>
        </g>
      ))}

      {/* Bucket */}
      <g className="node" transform={`translate(${BUCKET[0] - 50} ${BUCKET[1] - 40})`}>
        <path d="M0 0 L15 80 H85 L100 0" fill="#fff" stroke="#1f2937" strokeWidth="2" />
        <ellipse cx="50" cy="0" rx="50" ry="8" fill="#fff" stroke="#1f2937" strokeWidth="2" />
        {Array.from({ length: bucket }).map((_, i) => (
          <circle
            key={i}
            className={i === sent - 1 ? 'sent-flash' : ''}
            cx={28 + (i % 4) * 15}
            cy={70 - Math.floor(i / 4) * 14}
            r={6}
            fill={i < sent ? GREEN : BLUE}
          />
        ))}
        <text x="50" y="108">Bøtte</text>
      </g>

      {/* DBs */}
      {[
        { label: 'DB A', y: Y.A, items: dbAItems, down: downA },
        { label: 'DB B', y: Y.B, items: dbBItems, down: downB },
      ].map((d) => (
        <g key={d.label} className={`node ${d.down ? 'down' : ''}`} transform={`translate(${DB_X - 50} ${d.y - 45})`}>
          <g className={`db-body ${d.down ? 'gone' : ''}`}>
            <path d="M0 10 V80 a50 14 0 0 0 100 0 V10" fill="#fff" stroke="#1f2937" strokeWidth="2" />
            <ellipse cx="50" cy="10" rx="50" ry="14" fill="#fff" stroke="#1f2937" strokeWidth="2" />
            {d.items.map((c, i) => (
              <circle key={i} cx={22 + (i % 4) * 19} cy={70 - Math.floor(i / 4) * 18} r={7} fill={c} />
            ))}
          </g>
          <text x="50" y="125">{d.label}</text>
        </g>
      ))}

      {/* Read API */}
      <g style={{ transform: `translateY(${readY}px)`, transition: 'transform 0.8s ease-in-out' }}>
        <line x1={READ_X - 60} y1={0} x2={DB_X + 50} y2={0} stroke="#1f2937" strokeWidth="2" />
        <path d={`M${DB_X + 50} 0 l12 -6 v12 z`} fill="#1f2937" />
        <g className="node" transform={`translate(${READ_X - 60} -35)`}>
          <rect width="120" height="70" rx="8" />
          <text x="60" y="41">Read API</text>
        </g>
      </g>

      {/* Rocket */}
      {seqRocket && (
        <g key={seqRocket.key} className="fast" transform={`translate(${DB_X} ${seqRocket.y})`}>
          <g className="rocket-wrap">
            <g className="rocket">
              <text fontSize="40" textAnchor="middle" dominantBaseline="middle">🚀</text>
            </g>
          </g>
          <text className="boom" fontSize="90" textAnchor="middle" dominantBaseline="middle">💥</text>
        </g>
      )}
    </svg>
  )
}


