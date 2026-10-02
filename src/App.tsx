import { useEffect, useReducer, useRef, useState } from 'react'

type Pt = [number, number]
type Packet = {
  id: number
  t0: number
  path: Pt[]
  colors: string[]
  procSeg: number // first segment after the processing app
  speed?: number // px per second (defaults to SPEED)
  forceColor?: string // colour processing outputs for this ball, overriding its normal colour (bug)
  // Fiks balls: moved by distance so they can wait at the padlock
  dist?: number // distance travelled along the path (when set, replaces time-based motion)
  lockDist?: number // distance at which the padlock sits
  copyAt?: number // distance at which a copy is dropped into the bucket
  copied?: boolean
  latched?: string // colour decided when the packet reaches processing
}

// Current colour of the processing app's output
let procColor = '#3b82f6'

const BLUE = '#3b82f6'
const YELLOW = '#facc15'
const GREEN = '#22c55e'
const RED = '#ef4444'
const SPEED = 170 // px per second
const SEQ_SPEED = 450 // faster balls in the looping sequence (step 13)

const F: Pt = [110, 170]
const M: Pt = [335, 170]
const P: Pt = [560, 170]
const D: Pt = [850, 170] // end of the line, left edge of the DB
const DB_X = 900 // DB centre
const B: Pt = [335, 370]
const R: Pt = [560, 370]

const LOADING_STAGE = 10 // step 11
const TWO_DB_STAGE = 11 // step 12
const SEQ_STAGE = 12 // step 13: looping rocket / replay / swap sequence
const BUG_STAGE = 13 // step 14: replay into B, buggy processing makes every 4th ball red
const DESTROY_B_STAGE = 14 // step 15: replay stopped, rocket destroys DB B
const BUCKET_MAX = 16

const STAGES = [
  'En forenklet representasjon av Barnevernsregisteret.',
  'Innsendinger lagres i bøtte så fort de mottas, og sendes så videre for prosessering og lagring i database',
  'Databasen går dukken!',
  'Mottak stenges midlertidig.',
  'Replay-applikasjonen kjører alle tidligere innsendinger gjennom systemet.',
  'Systemet er tilbake i normal drift.',
  'Det rulles ut en endring i prosesseringen. Innsendinger som er håndtert på forskjellige måter ligger blandet.',
  'Vi kaster databasen og stenger mottak.',
  'Replay igjen.',
  'Normal drift. Alle innsendinger har nå vært gjennom den nye prosesseringen.',
  "Replay forårsaker nedetid. Det er mulig å lese fra databasen underveis, men dataene vil være ufullstendige.",
  'I Barnevernsregisteret har vi to parallelle database-instanser.',
  'Man kan lese fra en database og kjøre replay i den andre.',
  'Parallelle databaser gjør det også mulig å raskt avbryte replay ved behov.',
  'Parallelle databaser gjør det også mulig å raskt avbryte replay ved behov.',
  'Parallelle databaser gjør det også mulig å raskt avbryte replay ved behov.',
]
const FIKS_ACTIVE = [false, true, true, false, false, true, true, false, false, true, false, false, false, false, false, true]
const REPLAY_ACTIVE = [false, false, false, false, true, false, false, false, true, false, true, false, false, false, false, false]
const REPLAY_VISIBLE = [false, false, false, true, true, false, false, true, true, false, true, true, true, true, true, false]
const YELLOW_PROC = [false, false, false, false, false, false, true, true, true, true, false, false, false, false, false, false]
const BUG_PROC = [false, false, false, false, false, false, false, false, false, false, false, false, false, true, true, false]
const DB_DOWN = [false, false, true, true, false, false, false, true, false, false, false, false, false, false, false, false]
const ROCKET = [false, false, true, false, false, false, false, true, false, false, false, false, false, false, false, false]
const TWO_DBS = [false, false, false, false, false, false, false, false, false, false, false, true, true, true, true, true]
const DB_A_Y = 70
const DB_B_Y = 250
const DA_END: Pt = [D[0], DB_A_Y] // end of the line into DB A
const DB_END: Pt = [D[0], DB_B_Y] // end of the line into DB B
const READ_X = 1100 // Read API centre
const LOCK_X = 285 // padlock position on the Fiks line, just before the split to the bucket
const LOCK_SPACING = 22 // gap between balls waiting at the padlock
const LOCK_QUEUE_MAX = 4 // max balls waiting at the padlock
const LOCK_STOP = LOCK_X - 30 - F[0] // distance along the Fiks line where the first waiting ball stops

// A ball leaving Fiks (moved by distance so it can wait at the padlock)
function fiksPacket(id: number, twoDbs: boolean, t0: number, dist = 0): Packet {
  const path: Pt[] = twoDbs ? [F, P, [700, P[1]], [700, DB_A_Y], DA_END] : [F, P, D]
  return {
    id,
    t0,
    path,
    colors: [BLUE, BLUE],
    procSeg: 1,
    dist,
    lockDist: LOCK_STOP,
    copyAt: M[0] - F[0],
  }
}

const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])

function locate(p: Packet, now: number) {
  let d = p.dist ?? ((now - p.t0) / 1000) * (p.speed ?? SPEED)
  if (d < 0) return null
  for (let i = 0; i < p.path.length - 1; i++) {
    const l = len(p.path[i], p.path[i + 1])
    if (d <= l) {
      const k = d / l
      if (i >= p.procSeg && p.latched === undefined) p.latched = p.forceColor ?? procColor
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

export default function App() {
  const [stage, setStage] = useState(0)
  const [dbItems, setDbItems] = useState<string[]>([])
  const [bucket, setBucket] = useState(0)
  const falling = useRef<{ id: number; color: string; t0: number; y?: number }[]>([])
  const [dbDown, setDbDown] = useState(false)
  // Two-DB state (step 12+): contents, "down" flags, Read API target and the looping rocket
  const [dbAItems, setDbAItems] = useState<string[]>([])
  const [dbBItems, setDbBItems] = useState<string[]>([])
  const [downA, setDownA] = useState(false)
  const [downB, setDownB] = useState(false)
  const [readTarget, setReadTarget] = useState<'A' | 'B'>('A')
  const [seqRocket, setSeqRocket] = useState<{ key: number; y: number } | null>(null)
  const seqReplayRef = useRef(false) // sequence: replay currently sending
  const seqTargetRef = useRef<'A' | 'B'>('B') // sequence: DB that replay writes to
  const downARef = useRef(false)
  const replayCount = useRef(0) // balls sent in the bug step (every 4th turns red)
  const lockedRef = useRef(false) // Fiks is locked: its balls wait at the padlock
  const lastFrame = useRef(0)
  const downBRef = useRef(false)
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const packets = useRef<Packet[]>([])
  const dbDownRef = useRef(false)
  const nextId = useRef(0)

  const stageRef = useRef(0)
  const prevStageRef = useRef(0)
  const [sent, setSent] = useState(0) // bucket balls already sent by replay (marked green)
  const sentRef = useRef(0)
  const bucketRef = useRef(0)
  bucketRef.current = bucket
  const vbWidth = useRef(1000) // animated viewBox width (zooms out when the Read API appears)

  // Apply stage settings (in-flight packets are kept)
  useEffect(() => {
    stageRef.current = stage
    // Reset the "sent" marks when a new replay run starts, or the replay app is gone
    const prev = prevStageRef.current
    prevStageRef.current = stage
    if (!REPLAY_VISIBLE[stage] || (REPLAY_ACTIVE[stage] && !REPLAY_ACTIVE[prev])) {
      sentRef.current = 0
      setSent(0)
    }
    procColor = YELLOW_PROC[stage] ? YELLOW : BLUE
    lockedRef.current = !FIKS_ACTIVE[stage] && stage > 0
    if (stage === LOADING_STAGE) {
      // Fresh start: clear everything in motion, fill the bucket, start the db at 4
      packets.current = []
      falling.current = []
      setBucket(BUCKET_MAX)
      setDbItems(Array(4).fill(BLUE))
    }
    if (stage === TWO_DB_STAGE || stage === SEQ_STAGE || stage === BUG_STAGE) {
      // Clear everything in motion; the bucket stays full
      packets.current = []
      falling.current = []
      setBucket(BUCKET_MAX)
    }
    if (stage === BUG_STAGE) {
      // DB A holds 8 balls, DB B starts at 4 (it loads up as replay runs), Read API stays on A
      setDbAItems(Array(8).fill(BLUE))
      setDbBItems(Array(4).fill(BLUE))
      downARef.current = false
      downBRef.current = false
      setDownA(false)
      setDownB(false)
      setReadTarget('A')
      replayCount.current = 0
    }
    if (stage === TWO_DB_STAGE) {
      // Both DBs are full from the start
      setDbAItems(Array(12).fill(BLUE))
      setDbBItems(Array(12).fill(BLUE))
      downARef.current = false
      downBRef.current = false
      setDownA(false)
      setDownB(false)
      setReadTarget('A')
    }
    if (stage === 0) {
      // Empty starting point: nothing has flowed yet
      packets.current = []
      falling.current = []
      setBucket(0)
      setDbItems([])
    }
    // Steps 12-15: the queue at the padlock is full from the start
    if (stage > LOADING_STAGE && stage <= DESTROY_B_STAGE) {
      const waiting = packets.current.filter((p) => p.lockDist !== undefined && (p.dist ?? 0) <= p.lockDist).length
      const t0 = performance.now()
      for (let i = 0; i < LOCK_QUEUE_MAX - waiting; i++) {
        packets.current.push(fiksPacket(nextId.current++, TWO_DBS[stage], t0, LOCK_STOP - i * LOCK_SPACING))
      }
    }
    const delay = ROCKET[stage] ? 1200 : 0
    const t = setTimeout(() => {
      dbDownRef.current = DB_DOWN[stage]
      setDbDown(DB_DOWN[stage])
      if (DB_DOWN[stage] && ROCKET[stage]) setDbItems([])
    }, delay)
    if (!ROCKET[stage]) {
      dbDownRef.current = DB_DOWN[stage]
      setDbDown(DB_DOWN[stage])
    }
    return () => clearTimeout(t)
  }, [stage])

  // Step 15: a rocket destroys DB B (it stays down in the following step)
  useEffect(() => {
    if (stage > DESTROY_B_STAGE) {
      // Later steps: DB B stays destroyed
      downBRef.current = true
      setDownB(true)
      setDbBItems([])
      return
    }
    if (stage !== DESTROY_B_STAGE) return
    setSeqRocket({ key: Date.now(), y: DB_B_Y })
    const t = setTimeout(() => {
      downBRef.current = true
      setDownB(true)
      setDbBItems([])
    }, 1200)
    return () => {
      clearTimeout(t)
      setSeqRocket(null)
    }
  }, [stage])

  // Step 13: looping sequence. Blow up B, replay into B, swap Read API to B, then the same for A.
  useEffect(() => {
    if (stage !== SEQ_STAGE) return
    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number) =>
      new Promise<void>((res) => {
        timers.push(window.setTimeout(res, ms))
      })
    const waitUntil = async (cond: () => boolean) => {
      while (!cancelled && !cond()) await wait(50)
    }
    const setDown = (t: 'A' | 'B', v: boolean) => {
      if (t === 'A') {
        downARef.current = v
        setDownA(v)
      } else {
        downBRef.current = v
        setDownB(v)
      }
    }
    const setItems = (t: 'A' | 'B', items: string[]) => (t === 'A' ? setDbAItems(items) : setDbBItems(items))
    let rocketKey = 0

    const run = async () => {
      // Start state: both DBs hold data, Read API on A, bucket full
      setDbAItems(Array(12).fill(BLUE))
      setDbBItems(Array(12).fill(BLUE))
      setDown('A', false)
      setDown('B', false)
      setReadTarget('A')
      sentRef.current = 0
      setSent(0)
      await wait(600)
      while (!cancelled) {
        for (const t of ['B', 'A'] as const) {
          // 1. Rocket blows up the DB (fast rocket, see .fast in the CSS)
          setSeqRocket({ key: ++rocketKey, y: t === 'A' ? DB_A_Y : DB_B_Y })
          await wait(600)
          if (cancelled) return
          setDown(t, true)
          setItems(t, [])
          await wait(300)
          if (cancelled) return
          // 2. Replay into the DB, to completion
          setSeqRocket(null)
          setDown(t, false)
          seqTargetRef.current = t
          sentRef.current = 0
          setSent(0)
          seqReplayRef.current = true
          // Done when everything is sent and no replay ball is still on its way (Fiks balls waiting at the padlock don't count)
          await waitUntil(
            () => sentRef.current >= bucketRef.current && !packets.current.some((p) => p.path[0] === B),
          )
          seqReplayRef.current = false
          if (cancelled) return
          // 3. Swap the Read API to this DB, and go straight on to the next phase
          setReadTarget(t)
        }
      }
    }
    run()

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
      seqReplayRef.current = false
      setSeqRocket(null)
      setDown('A', false)
      setDown('B', false)
      setReadTarget('A')
      setDbAItems([])
      setDbBItems([])
      sentRef.current = 0
      setSent(0)
    }
  }, [stage])

  // Emit packets (one continuous emitter that reads the current stage)
  useEffect(() => {
    const add = (t0: number, path: Pt[], colors: string[], procSeg = 99, speed?: number) =>
      packets.current.push({ id: nextId.current++, t0, path, colors, procSeg, speed })
    const emitFiks = () => {
      const stage = stageRef.current
      if (stage === 0) return // step 1: nothing flows
      const now = performance.now()
      // While locked, balls still leave Fiks and queue up at the padlock (cap the queue)
      if (lockedRef.current) {
        const waiting = packets.current.filter((p) => p.lockDist !== undefined && (p.dist ?? 0) <= p.lockDist).length
        if (waiting >= LOCK_QUEUE_MAX) return
      }
      packets.current.push(fiksPacket(nextId.current++, TWO_DBS[stage], now))
    }
    // Replay emits three times as often, at the same speed. One ball per bucket ball (first in, first out).
    const emitReplay = () => {
      const stage = stageRef.current
      if (stage === SEQ_STAGE) {
        // handled by emitSeq (faster)
      } else if (stage === BUG_STAGE) {
        // Infinite replay into DB B at normal speed; every fourth ball leaves processing red
        replayCount.current++
        const bend1: Pt = [700, P[1]]
        const bend2: Pt = [700, DB_B_Y]
        packets.current.push({
          id: nextId.current++,
          t0: performance.now(),
          path: [B, R, P, bend1, bend2, DB_END],
          colors: [BLUE, BLUE],
          procSeg: 2,
          forceColor: replayCount.current % 4 === 1 ? RED : undefined,
        })
      } else if (stage === LOADING_STAGE) {
        // Step 13 runs forever: no marking, no limit
        add(performance.now(), [B, R, P, D], [BLUE, BLUE, BLUE], 2)
      } else if (REPLAY_ACTIVE[stage] && sentRef.current < bucketRef.current) {
        add(performance.now(), [B, R, P, D], [BLUE, BLUE, BLUE], 2)
        sentRef.current++
        setSent(sentRef.current)
      }
    }
    emitFiks()
    emitReplay()
    const i1 = setInterval(emitFiks, 1100)
    const i2 = setInterval(emitReplay, 1100 / 3)
    // Step 13 only: faster balls, emitted proportionally more often so the spacing stays the same
    const emitSeq = () => {
      if (stageRef.current !== SEQ_STAGE) return
      if (seqReplayRef.current && sentRef.current < bucketRef.current) {
        const t = seqTargetRef.current
        const y = t === 'A' ? DB_A_Y : DB_B_Y
        const bend1: Pt = [700, P[1]]
        const bend2: Pt = [700, y]
        add(performance.now(), [B, R, P, bend1, bend2, t === 'A' ? DA_END : DB_END], [BLUE, BLUE], 2, SEQ_SPEED)
        sentRef.current++
        setSent(sentRef.current)
      }
    }
    const i3 = setInterval(emitSeq, 1100 / 3 / (SEQ_SPEED / SPEED))
    return () => {
      clearInterval(i1)
      clearInterval(i2)
      clearInterval(i3)
    }
  }, [])

  // Animation loop
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const now = performance.now()
      const dt = lastFrame.current ? Math.min(0.05, (now - lastFrame.current) / 1000) : 0
      lastFrame.current = now
      // Move Fiks balls by distance. While locked they stop (and queue) at the padlock.
      const movers = packets.current.filter((p) => p.dist !== undefined).sort((a, b) => b.dist! - a.dist!)
      let ceiling = Infinity
      for (const p of movers) {
        let nd = p.dist! + (p.speed ?? SPEED) * dt
        if (lockedRef.current && p.lockDist !== undefined && p.dist! <= p.lockDist) {
          nd = Math.max(p.dist!, Math.min(nd, ceiling, p.lockDist))
          ceiling = nd - LOCK_SPACING
        }
        p.dist = nd
        if (p.copyAt !== undefined && !p.copied && nd >= p.copyAt) {
          p.copied = true
          packets.current.push({ id: nextId.current++, t0: now, path: [M, B], colors: [BLUE], procSeg: 99 })
        }
      }
      const keep: Packet[] = []
      for (const p of packets.current) {
        const r = locate(p, now)
        if (r === 'done') {
          const end = p.path[p.path.length - 1]
          if (end === DA_END || end === DB_END) {
            const c = p.latched ?? p.colors[p.colors.length - 1]
            const isA = end === DA_END
            if (stageRef.current === BUG_STAGE && c === RED) {
              // Red (buggy) balls fall off even though the DB is there
              falling.current.push({ id: nextId.current++, color: c, t0: now, y: end[1] })
            } else if (isA ? downARef.current : downBRef.current) {
              // Greyed-out DB: the ball falls
              falling.current.push({ id: nextId.current++, color: c, t0: now, y: end[1] })
            } else {
              const add = (x: string[]) => {
                // Bug step: loading effect on DB B, at 8 balls reset to 4
                if (stageRef.current === BUG_STAGE) return x.length >= 8 ? x.slice(0, 4) : [...x, c]
                return [...x, c].slice(-12)
              }
              if (isA) setDbAItems(add)
              else setDbBItems(add)
            }
          } else if (end === D && !dbDownRef.current) {
            const c = p.latched ?? p.colors[p.colors.length - 1]
            // Keep the bottom 4 (oldest) balls; evict the 5th instead so a mix stays visible
            setDbItems((x) => {
              // Loading effect: at 8 balls, reset to 4
              if (stageRef.current === LOADING_STAGE) return x.length >= 8 ? x.slice(0, 4) : [...x, c]
              return x.length >= 12 ? [...x.slice(0, 4), ...x.slice(5), c] : [...x, c]
            })
          } else if (end === D) {
            falling.current.push({ id: nextId.current++, color: p.latched ?? p.colors[p.colors.length - 1], t0: now })
          } else if (end === B) setBucket((n) => Math.min(n + 1, BUCKET_MAX))
        } else keep.push(p)
      }
      packets.current = keep
      const targetW = TWO_DBS[stageRef.current] ? 1180 : 1000
      vbWidth.current += (targetW - vbWidth.current) * 0.08
      if (Math.abs(targetW - vbWidth.current) < 0.5) vbWidth.current = targetW
      falling.current = falling.current.filter((f) => now - f.t0 < 1200)
      tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setStage((s) => Math.min(s + 1, STAGES.length - 1))
      if (e.key === 'ArrowLeft') setStage((s) => Math.max(s - 1, 0))
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const now = performance.now()
  const locked = !FIKS_ACTIVE[stage] && stage > 0
  const replayOn = REPLAY_VISIBLE[stage]
  const procYellow = YELLOW_PROC[stage]
  const bugProc = BUG_PROC[stage]
  const twoDbs = TWO_DBS[stage]
  const readY = readTarget === 'A' ? DB_A_Y : DB_B_Y

  return (
    <>
      <svg viewBox={`0 0 ${vbWidth.current} 480`}>
        {/* edges */}
        <path className="edge" d={`M${F} L${P}`} />
        <g className={`fade ${twoDbs ? 'hidden' : ''}`}>
          <path className="edge" d={`M${P} L${D}`} />
        </g>
        <g className={`fade ${twoDbs ? '' : 'hidden'}`}>
          <path className="edge" d={`M${P} L700,${P[1]} L700,${DB_A_Y} L${D[0]},${DB_A_Y}`} />
          <path className="edge" d={`M${P} L700,${P[1]} L700,${DB_B_Y} L${D[0]},${DB_B_Y}`} />
        </g>
        <path className="edge" d={`M${M} L${B}`} />
        <g className={`fade ${replayOn ? '' : 'hidden'}`}>
          <path className="edge" d={`M${B} L${R} L${P}`} />
        </g>

        {/* packets */}
        {packets.current.map((p) => {
          const r = locate(p, now)
          if (!r || r === 'done') return null
          return <circle key={p.id} cx={r.x} cy={r.y} r={9} fill={r.color} />
        })}

        {/* falling balls (db down) */}
        {falling.current.map((f) => {
          const t = Math.max(0, (now - f.t0) / 1000)
          return (
            <circle key={f.id} cx={D[0] + 25 * t} cy={(f.y ?? D[1]) + 700 * t * t} r={9} fill={f.color} opacity={Math.max(0, 1 - t / 1.2)} />
          )
        })}

        {/* Padlock on the line, just before the split to the bucket */}
        <g className={`fade ${locked ? '' : 'hidden'}`} transform={`translate(${LOCK_X} ${F[1]})`}>
          <text textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 50 }}>🔒</text>
        </g>

        {/* Fiks */}
        <g className="node" transform={`translate(${F[0] - 60} ${F[1] - 35})`}>
          <rect width="120" height="70" rx="8" />
          <text x="60" y="41">Fiks IO</text>
        </g>

        {/* Processing */}
        <g className={`node ${procYellow ? 'yellow' : ''} ${bugProc ? 'bug' : ''}`} transform={`translate(${P[0] - 60} ${P[1] - 35})`}>
          <rect width="120" height="70" rx="8" />
          <text x="60" y="41">Prosessering</text>
          {procYellow && <circle cx="100" cy="14" r="6" fill={YELLOW} />}
          <text
            className={`fade ${bugProc ? '' : 'hidden'}`}
            x="10"
            y="-20"
            rotate={"60"}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: 40 }}
          >
            🪲
          </text>
        </g>

        {/* Replay */}
        <g className={`node fade ${replayOn ? '' : 'hidden'}`} transform={`translate(${R[0] - 60} ${R[1] - 35})`}>
          <rect width="120" height="70" rx="8" />
          <text x="60" y="41">Replay app</text>
        </g>

        {/* Bucket */}
        <g className="node" transform={`translate(${B[0] - 50} ${B[1] - 40})`}>
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

        {/* Check mark: all bucket data has been sent to replay */}
        <g className={`fade ${replayOn && bucket > 0 && sent >= bucket ? '' : 'hidden'}`} transform="translate(447 335)">
          <circle r="14" fill={GREEN} />
          <path d="M-7 0 l5 6 l9 -11" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </g>

        {/* DB */}
        <g className={`node fade ${twoDbs ? 'hidden' : ''} ${dbDown ? 'down' : ''}`} transform={`translate(${DB_X - 50} ${D[1] - 45})`}>
          <g className={`db-body ${dbDown ? 'gone' : ''}`}>
            <path d="M0 10 V80 a50 14 0 0 0 100 0 V10" fill="#fff" stroke="#1f2937" strokeWidth="2" />
            <ellipse cx="50" cy="10" rx="50" ry="14" fill="#fff" stroke="#1f2937" strokeWidth="2" />
            {dbItems.map((c, i) => (
              <circle key={i} cx={22 + (i % 4) * 19} cy={70 - Math.floor(i / 4) * 18} r={7} fill={c} />
            ))}
          </g>
          <text x="50" y="125">DB</text>
        </g>

        {/* Two parallel DBs (A and B) */}
        {[
          { label: 'DB A', y: DB_A_Y, items: dbAItems, down: downA },
          { label: 'DB B', y: DB_B_Y, items: dbBItems, down: downB },
        ].map((d) => (
          <g key={d.label} className={`node fade ${twoDbs ? '' : 'hidden'} ${d.down ? 'down' : ''}`} transform={`translate(${DB_X - 50} ${d.y - 45})`}>
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

        {/* Read API, connected to one DB at a time */}
        <g className={`fade ${twoDbs ? '' : 'hidden'}`}>
          {/* moves up/down (animated) to the DB it is connected to */}
          <g style={{ transform: `translateY(${readY}px)`, transition: 'transform 0.8s ease-in-out' }}>
            <line x1={READ_X - 60} y1={0} x2={DB_X + 50} y2={0} stroke="#1f2937" strokeWidth="2" />
            <path d={`M${DB_X + 50} 0 l12 -6 v12 z`} fill="#1f2937" />
            <g className="node" transform={`translate(${READ_X - 60} -35)`}>
              <rect width="120" height="70" rx="8" />
              <text x="60" y="41">Read API</text>
            </g>
          </g>
        </g>

        {/* Rocket */}
        {ROCKET[stage] && (
          <g key={stage} transform={`translate(${DB_X} ${D[1]})`}>
            <g className="rocket-wrap">
              <g className="rocket">
                <text fontSize="40" textAnchor="middle" dominantBaseline="middle">🚀</text>
              </g>
            </g>
            <text className="boom" fontSize="90" textAnchor="middle" dominantBaseline="middle">💥</text>
          </g>
        )}
        {seqRocket && (
          <g key={seqRocket.key} className={stage === SEQ_STAGE ? 'fast' : undefined} transform={`translate(${DB_X} ${seqRocket.y})`}>
            <g className="rocket-wrap">
              <g className="rocket">
                <text fontSize="40" textAnchor="middle" dominantBaseline="middle">🚀</text>
              </g>
            </g>
            <text className="boom" fontSize="90" textAnchor="middle" dominantBaseline="middle">💥</text>
          </g>
        )}
      </svg>

      <div className="caption">{STAGES[stage]}</div>
      <div className="controls">
        <button disabled={stage === 0} onClick={() => setStage(stage - 1)}>← Back</button>
        <span>{stage + 1} / {STAGES.length}</span>
        <button disabled={stage === STAGES.length - 1} onClick={() => setStage(stage + 1)}>Next →</button>
      </div>
    </>
  )
}

