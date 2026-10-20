import { useRef, type CSSProperties } from 'react'
import StepControls from '../components/StepControls'
import { useSequence, useStepNavigation } from '../hooks'

// ---------- Steps ----------
// Steps 0-5: the first sak. After that come scenarios, each with 6 steps (see SCENARIOS below).
const STEP = { SAK_IN: 0, LOOKUP_EMPTY: 1, CREATE_EVENTS: 2, STORE: 3, LOOKUP: 4, REBUILD: 5 } as const
const SCENARIO_STEPS = 6

const CAPTIONS = [
  'Vi mottar en innsendt sak.',
  'Vi sjekker om saken finnes i event-databasen. Ingen treff.',
  'Vi går gjennom saken og lager et event for hver endring.',
  'Events lagres i databasen.',
  'Når vi skal bygge opp siste versjon av en sak henter vi først ut alle events tilhørende saken.',
  'Vi går gjennom alle events i kronologisk rekkefølge, og endrer de spesifiserte feltene. Til slutt sitter vi igjen med den fullstendige saken',
  // Scenario 1: other fødselsnummer and another tiltak
  'En ny innsending av saken kommer inn. Samme sak-uuid, men et annet fødselsnummer og et annet tiltak.',
  'Vi slår opp sak-uuid og finner 4 events fra forrige gang.',
  'Nå må vi først bygge den eksisterende saken fra disse eventene.',
  'Vi sammenligner innkommende og eksisterende sak felt for felt, og der vi finner endringer lager vi events.',
  'De nye eventene lagres, og vi henter ut alle eventene på saken.',
  'Vi bygger den fullstendige saken, som nå har to tiltak.',
  // Scenario 2: the tiltak is marked as deleted
  'En ny innsending for en eksisterende sak kommer inn: samme tiltak, men med ErSlettet = true.',
  'Vi bygger den eksisterende saken fra eksisterende events.',
  'Vi bygger den eksisterende saken fra eksisterende events.',
  'Vi sammenligner felt for felt. Eneste forskjell er ErSlettet, som gir ett nytt event.',
  'Det nye eventet lagres, og vi henter ut alle eventene på saken.',
  'Vi bygger saken. Når vi kommer til «ErSlettet oppdatert» fjernes tiltaket.',
  // Toggling
  'Ved å endre ErSlettet kan vi slette og gjenopprette elementer.',
]

// ---------- Data model ----------
type Tiltak = { uuid: string; startdato?: string; erSlettet?: boolean }
/** A sak that may be partially built (while events are being applied) */
type SakState = { uuid?: string; fodselsnummer?: string; tiltak: Tiltak[] }
/** A complete sak (what comes in from outside) */
type Sak = { uuid: string; fodselsnummer: string; tiltak: (Tiltak & { startdato: string })[] }

const EMPTY_SAK: SakState = { tiltak: [] }

const SAK_V1: Sak = {
  uuid: '7f3a9c2e-…',
  fodselsnummer: '010190 12345',
  tiltak: [{ uuid: 'c91d04b7-…', startdato: '2025-03-01' }],
}
// Same sak, but with another fødselsnummer and another tiltak
const SAK_V2: Sak = {
  uuid: SAK_V1.uuid,
  fodselsnummer: '020285 54321',
  tiltak: [{ uuid: '5be2f7a1-…', startdato: '2025-09-15' }],
}
// Same sak and same tiltak as V1, but the tiltak is now marked as deleted
const SAK_V3: Sak = {
  ...SAK_V1,
  tiltak: SAK_V1.tiltak.map((t) => ({ ...t, erSlettet: true })),
}

/** Which part of the sak card an event touches */
type Part = 'uuid' | 'fnr' | 'tiltak' | 'startdato' | 'erslettet'

type EventDef = {
  name: string
  fields: [label: string, value: string][]
  part: Part
  tiltakUuid?: string
  apply: (sak: SakState) => SakState
}

const sakOpprettet = (uuid: string): EventDef => ({
  name: 'Sak opprettet',
  fields: [['sak-uuid', uuid]],
  part: 'uuid',
  apply: (s) => ({ ...s, uuid }),
})
const fodselsnummerOppdatert = (sakUuid: string, fodselsnummer: string): EventDef => ({
  name: 'Fødselsnummer oppdatert',
  fields: [['sak-uuid', sakUuid], ['fødselsnummer', fodselsnummer]],
  part: 'fnr',
  apply: (s) => ({ ...s, fodselsnummer }),
})
const tiltakOpprettet = (sakUuid: string, tiltakUuid: string): EventDef => ({
  name: 'Tiltak opprettet',
  fields: [['tiltak-uuid', tiltakUuid], ['sak-uuid', sakUuid]],
  part: 'tiltak',
  tiltakUuid,
  apply: (s) => ({ ...s, tiltak: [...s.tiltak, { uuid: tiltakUuid }] }),
})
const startdatoOppdatert = (tiltakUuid: string, startdato: string): EventDef => ({
  name: 'Tiltak startdato oppdatert',
  fields: [['tiltak-uuid', tiltakUuid], ['startdato', startdato]],
  part: 'startdato',
  tiltakUuid,
  apply: (s) => ({ ...s, tiltak: s.tiltak.map((t) => (t.uuid === tiltakUuid ? { ...t, startdato } : t)) }),
})
// A tiltak marked as deleted is not shown in the built sak (see visibleSak); false brings it back
const erSlettetOppdatert = (tiltakUuid: string, erSlettet: boolean): EventDef => ({
  name: 'ErSlettet oppdatert',
  fields: [['tiltak-uuid', tiltakUuid], ['erSlettet', String(erSlettet)]],
  part: 'erslettet',
  tiltakUuid,
  apply: (s) => ({ ...s, tiltak: s.tiltak.map((t) => (t.uuid === tiltakUuid ? { ...t, erSlettet } : t)) }),
})

/** Compare the existing sak with an incoming one, top to bottom. Every difference becomes an event. */
function diffEvents(existing: SakState, incoming: Sak): EventDef[] {
  const events: EventDef[] = []
  if (existing.uuid !== incoming.uuid) events.push(sakOpprettet(incoming.uuid))
  if (existing.fodselsnummer !== incoming.fodselsnummer) {
    events.push(fodselsnummerOppdatert(incoming.uuid, incoming.fodselsnummer))
  }
  for (const t of incoming.tiltak) {
    const old = existing.tiltak.find((e) => e.uuid === t.uuid)
    if (!old) events.push(tiltakOpprettet(incoming.uuid, t.uuid))
    if (old?.startdato !== t.startdato) events.push(startdatoOppdatert(t.uuid, t.startdato))
    if ((old?.erSlettet ?? false) !== (t.erSlettet ?? false)) events.push(erSlettetOppdatert(t.uuid, t.erSlettet ?? false))
  }
  return events
}

/** Build a sak by applying the first `n` events in order */
const buildSak = (events: EventDef[], n = events.length): SakState =>
  events.slice(0, n).reduce((sak, e) => e.apply(sak), EMPTY_SAK)

/** The sak as it is shown when built: tiltak that are marked as deleted are gone */
const visibleSak = (sak: SakState): SakState => ({ ...sak, tiltak: sak.tiltak.filter((t) => !t.erSlettet) })

/** Most tiltak the sak has at any point while the events are applied (= slots the card needs) */
const maxTiltak = (events: EventDef[]) =>
  Math.max(1, ...events.map((_, n) => buildSak(events, n + 1).tiltak.length))

const EVENTS_V1 = diffEvents(EMPTY_SAK, SAK_V1) // the 4 events from the first time

// ---------- Scenarios ----------
// A scenario: the DB holds `base`, a new version of the sak comes in, and the differences become new events.
// Each scenario is 6 steps: new sak, lookup, build existing, compare, lookup all, build all.
type ScenarioDef = {
  start: number // first step of the scenario
  incoming: Sak
  base: EventDef[]
  skipIncomingHighlight: Part[] // rows not highlighted in the incoming (left) sak while comparing
}
const SCENARIO_DEFS: ScenarioDef[] = [
  { start: 6, incoming: SAK_V2, base: EVENTS_V1, skipIncomingHighlight: ['startdato'] },
  { start: 12, incoming: SAK_V3, base: EVENTS_V1, skipIncomingHighlight: [] },
]

function makeScenario(def: ScenarioDef) {
  const s = def.start
  const steps = { newSak: s, lookupExisting: s + 1, rebuildExisting: s + 2, compare: s + 3, lookupAll: s + 4, rebuildAll: s + 5 }
  const newEvents = diffEvents(buildSak(def.base), def.incoming)
  const allEvents = [...def.base, ...newEvents]
  // Rows compared top to bottom. The erSlettet row only exists when a tiltak has it.
  const rows: Part[] = ['uuid', 'fnr', 'tiltak', 'startdato']
  if (def.incoming.tiltak.some((t) => t.erSlettet !== undefined)) rows.push('erslettet')
  return { ...def, steps, newEvents, allEvents, rows }
}
type Scenario = ReturnType<typeof makeScenario>
const SCENARIOS = SCENARIO_DEFS.map(makeScenario)
const rowOf = (sc: Scenario, e: EventDef) => sc.rows.indexOf(e.part)

// Last step: the same tiltak is toggled between deleted and not deleted, one event per change
const TOGGLE_STEP = SCENARIOS[SCENARIOS.length - 1].start + SCENARIO_STEPS
const TOGGLE_EVENTS = Array.from({ length: 7 }, (_, i) => erSlettetOppdatert(SAK_V3.tiltak[0].uuid, i % 2 === 0))

// Speed of the top-to-bottom walk through the sak (create events, compare). 1 = original speed.
const SCAN_SPEED = 0.6

// ---------- Layout ----------
const VIEW_W = 1370
const VIEW_H = 460
const CARD_W = 290
const CARD_Y = 30
const TILTAK_H = 112
const TILTAK_PITCH = 120
const LEFT_CARD_X = 20
const EXISTING_CARD_X = 335 // existing sak slides here, next to the incoming one
const RIGHT_CARD_X = 1060
const CHIP_W = 220
const CHIP_H = 50
const CHIP_GAP = 6
const LEFT_CHIP_X = 335 // events created from the first sak
const NEW_CHIP_X = 800 // events created by the comparison
const RIGHT_CHIP_X = 815 // events fetched from the DB
const DB_X = 575
const DB_W = 220
const DB_Y = 40
const DB_H = 270
const DB_CX = DB_X + DB_W / 2

const slotY = (i: number) => CARD_Y + i * (CHIP_H + CHIP_GAP)
const VAULT_X = DB_X + (DB_W - CHIP_W) / 2 // chip position hidden behind the DB
const VAULT_Y = DB_Y + DB_H / 2 - CHIP_H / 2
const at = (x: number, y: number) => `translate(${x}px, ${y}px)`
const cardHeight = (slots: number) => 120 + slots * TILTAK_PITCH
const tiltakTop = (k: number) => 113 + k * TILTAK_PITCH

// ---------- Highlight ----------
type Highlight = { part: Part; tiltak?: number; tone?: 'change' | 'same' }
const TONES = { change: '#fef9c3', same: '#dcfce7' }

function highlightRect({ part, tiltak = 0 }: Highlight) {
  const top = tiltakTop(tiltak)
  if (part === 'uuid') return { y: 46, h: 26 }
  if (part === 'fnr') return { y: 81, h: 26 }
  if (part === 'tiltak') return { y: top + 8, h: 50 }
  if (part === 'startdato') return { y: top + 59, h: 24 }
  return { y: top + 83, h: 24 }
}

/** Highlight for the part of `sak` that an event touches */
function highlightFor(e: EventDef, sak: SakState): Highlight {
  const tiltak = e.tiltakUuid ? Math.max(0, sak.tiltak.findIndex((t) => t.uuid === e.tiltakUuid)) : undefined
  return { part: e.part, tiltak }
}

// ---------- Rounds ----------
/** Events created in a step, then sucked into the DB in a later step */
type CreateRound = {
  events: EventDef[]
  x: number
  create: number
  store: number
  storeDelay: number
  scenario?: Scenario // set when the events come from a comparison
}
const CREATE_ROUNDS: CreateRound[] = [
  { events: EVENTS_V1, x: LEFT_CHIP_X, create: STEP.CREATE_EVENTS, store: STEP.STORE, storeDelay: 0 },
  // The DB fades in first, then the new events go in
  ...SCENARIOS.map((sc) => ({
    events: sc.newEvents,
    x: NEW_CHIP_X,
    create: sc.steps.compare,
    store: sc.steps.lookupAll,
    storeDelay: 0.7,
    scenario: sc,
  })),
]

/** Lookup in the DB, events come out on the right, then a sak is built from them */
type FetchRound = {
  lookup: number
  rebuild: number
  events: EventDef[]
  slots: number // tiltak slots in the built sak card
  lookupDelay: number // seconds before the lookup starts
  chipsExit?: number // step where the event chips fade out
  cardExit?: number // step where the built sak fades out
  slideLeftAt?: number // step where the built sak slides left (existing sak)
}
const FETCH_ROUNDS: FetchRound[] = [
  {
    lookup: STEP.LOOKUP,
    rebuild: STEP.REBUILD,
    events: EVENTS_V1,
    slots: maxTiltak(EVENTS_V1),
    lookupDelay: 0,
    chipsExit: SCENARIOS[0].steps.newSak,
    cardExit: SCENARIOS[0].steps.newSak,
  },
  ...SCENARIOS.flatMap((sc, i): FetchRound[] => [
    {
      lookup: sc.steps.lookupExisting,
      rebuild: sc.steps.rebuildExisting,
      events: sc.base,
      slots: maxTiltak(sc.base),
      lookupDelay: 0,
      chipsExit: sc.steps.compare,
      cardExit: sc.steps.lookupAll,
      slideLeftAt: sc.steps.compare,
    },
    {
      lookup: sc.steps.lookupAll,
      rebuild: sc.steps.rebuildAll,
      events: sc.allEvents,
      slots: maxTiltak(sc.allEvents),
      lookupDelay: 2.2,
      // fades out when the next scenario starts
      chipsExit: SCENARIOS[i + 1]?.steps.newSak ?? TOGGLE_STEP,
      cardExit: SCENARIOS[i + 1]?.steps.newSak ?? TOGGLE_STEP,
    },
  ]),
]
const isActive = (stage: number, from: number, exit = Infinity) => stage >= from && stage <= exit

// ---------- Components ----------
function EventChip({ event, active, style }: { event: EventDef; active?: boolean; style: CSSProperties }) {
  return (
    <g className={`ev ${active ? 'active' : ''}`} style={style}>
      <rect width={CHIP_W} height={CHIP_H} rx="6" />
      <text x={CHIP_W / 2} y="16" className="ev-name">{event.name}</text>
      {event.fields.map(([label, value], i) => (
        <text key={label} x={CHIP_W / 2} y={31 + i * 13} className="ev-field">{label}: {value}</text>
      ))}
    </g>
  )
}

type SakCardProps = { x: number; y: number; sak: SakState; slots: number; highlight?: Highlight; opacity?: number }

/** The Sak object. Fields fade in as they get values, and a removed tiltak fades out. */
function SakCard({ x, y, sak, slots, highlight, opacity = 1 }: SakCardProps) {
  // Remember the last tiltak in each slot so its content stays visible while it fades out
  const lastTiltak = useRef<Tiltak[]>([])
  const show = (v: unknown): CSSProperties => ({ opacity: v === undefined ? 0 : 1, transition: 'opacity 0.6s' })
  const hl = highlight && highlightRect(highlight)
  return (
    <g style={{ transform: at(x, y), opacity, transition: 'transform 1.2s ease-in-out, opacity 0.6s', animation: 'appear 0.6s backwards' }}>
      <rect width={CARD_W} height={cardHeight(slots)} rx="8" fill="#fff" stroke="#1f2937" strokeWidth="2" />
      <text x="20" y="26" className="field-title">Sak</text>
      {hl && <rect x="8" y={hl.y} width={CARD_W - 16} height={hl.h} rx="4" fill={TONES[highlight.tone ?? 'change']} />}
      <g style={show(sak.uuid)}>
        <text x="20" y="63" className="field">uuid: {sak.uuid}</text>
      </g>
      <g style={show(sak.fodselsnummer)}>
        <text x="20" y="98" className="field">fødselsnummer: {sak.fodselsnummer}</text>
      </g>
      {Array.from({ length: slots }, (_, k) => {
        const live = sak.tiltak[k]
        if (live) lastTiltak.current[k] = live
        const t = live ?? lastTiltak.current[k]
        const top = tiltakTop(k)
        return (
          <g key={k}>
            <g style={show(live)}>
              <rect x="12" y={top} width={CARD_W - 24} height={TILTAK_H} rx="6" fill="none" stroke="#9ca3af" strokeWidth="2" />
              <text x="26" y={top + 27} className="field-title">Tiltak</text>
              <text x="26" y={top + 53} className="field">uuid: {t?.uuid}</text>
            </g>
            <g style={show(live?.startdato)}>
              <text x="26" y={top + 76} className="field">startdato: {t?.startdato}</text>
            </g>
            <g style={show(live?.erSlettet)}>
              <text x="26" y={top + 99} className="field">erSlettet: {String(t?.erSlettet)}</text>
            </g>
          </g>
        )
      })}
    </g>
  )
}

function Database({ label, opacity, delay }: { label: string; opacity: number; delay: number }) {
  return (
    <g transform={`translate(${DB_X} ${DB_Y})`} style={{ opacity, transition: `opacity 0.6s ${delay}s` }}>
      <path d={`M0 14 V${DB_H - 14} a${DB_W / 2} 16 0 0 0 ${DB_W} 0 V14`} fill="#fff" stroke="#1f2937" strokeWidth="2" />
      <ellipse cx={DB_W / 2} cy="14" rx={DB_W / 2} ry="14" fill="#fff" stroke="#1f2937" strokeWidth="2" />
      <text x={DB_W / 2} y="-8" className="label">{label}</text>
    </g>
  )
}

/** SQL snippet shown on top of the DB, followed by a result label. Remount (key) to restart. */
function Lookup({ sql, result, ok, delay = 0 }: { sql: string[]; result: string; ok: boolean; delay?: number }) {
  const w = 200
  const h = 16 * sql.length + 20
  return (
    <g>
      <g transform={`translate(${DB_CX - w / 2} ${DB_Y + 60})`} style={{ animation: `appear 0.4s ${delay}s both` }}>
        <rect width={w} height={h} rx="6" className="sql-box" />
        {sql.map((line, i) => (
          <text key={i} x="10" y={22 + i * 16} className="sql">{line}</text>
        ))}
      </g>
      <text
        x={DB_CX}
        y={DB_Y + DB_H + 50}
        className="label"
        style={{ fill: ok ? '#16a34a' : '#dc2626', animation: `appear 0.5s ${delay + 1}s both` }}
      >
        {result}
      </text>
    </g>
  )
}

/** Left-to-right arrow along the bottom, showing the direction of processing. */
function FlowArrow({ y }: { y: number }) {
  const x2 = VIEW_W - 20
  return (
    <g>
      <line x1={20} y1={y} x2={x2 - 2} y2={y} stroke="#9ca3af" strokeWidth="3" />
      <path d={`M${x2} ${y} l-14 -8 v16 z`} fill="#9ca3af" />
    </g>
  )
}

// ---------- Page ----------
export default function Eventstore() {
  const [stage, setStage] = useStepNavigation(CAPTIONS.length)

  // The scenario we are in (if any), and which of its steps this is
  const current = [...SCENARIOS].reverse().find((sc) => stage >= sc.start) // latest scenario that has started
  const scenario = current && stage < current.start + SCENARIO_STEPS ? current : undefined
  const isToggle = stage === TOGGLE_STEP
  const isCompare = !!scenario && stage === scenario.steps.compare
  const isLookupAll = !!scenario && stage === scenario.steps.lookupAll

  // Progress counters for the steps that play out over time
  const created = useSequence(stage === STEP.CREATE_EVENTS, EVENTS_V1.length, 600 / SCAN_SPEED, 900 / SCAN_SPEED)
  const rebuildRound = FETCH_ROUNDS.find((r) => r.rebuild === stage)
  const built = useSequence(!!rebuildRound, rebuildRound?.events.length ?? 0, 800, 1000)
  const compared = useSequence(isCompare, scenario?.rows.length ?? 0, 800 / SCAN_SPEED, 1100 / SCAN_SPEED)
  const compareRow = isCompare ? compared - 1 : -1
  const toggled = useSequence(isToggle, TOGGLE_EVENTS.length, 1600, 900, 600) // loops

  const sql = ['SELECT * FROM events', 'WHERE sak_uuid =', `  '${SAK_V1.uuid}'`, 'ORDER BY id;']
  const incoming = current?.incoming ?? SAK_V1 // sak on the left

  // Toggle step: the 4 base events, then the many ErSlettet events, applied one by one
  const toggleEvents = [...EVENTS_V1, ...TOGGLE_EVENTS]
  const toggleRaw = buildSak(toggleEvents, EVENTS_V1.length + toggled)

  // Is this event chip visible while its create step plays?
  const createdVisible = (round: CreateRound, i: number) =>
    round.scenario ? rowOf(round.scenario, round.events[i]) <= compareRow : i < created

  // Created events: appear next to the sak, later sucked into the DB
  const createdStyle = (round: CreateRound, i: number): CSSProperties => {
    const slot = at(round.x, slotY(i))
    const vault = at(VAULT_X, VAULT_Y)
    if (stage === round.create) {
      return { transform: slot, opacity: createdVisible(round, i) ? 1 : 0, transition: 'opacity 0.5s' }
    }
    if (stage === round.store) {
      const d = round.storeDelay + i * 0.25
      return { transform: vault, opacity: 0, transition: `transform 0.8s ease-in-out ${d}s, opacity 0.15s ${d + 0.7}s` }
    }
    return { transform: stage < round.create ? slot : vault, opacity: 0, transition: 'none' }
  }

  // Fetched events: emerge from behind the DB one by one, stay, then fade out
  const fetchedStyle = (round: FetchRound, i: number): CSSProperties => {
    const slot = at(RIGHT_CHIP_X, slotY(i))
    if (stage === round.chipsExit) return { transform: slot, animation: 'fade-out 0.5s forwards' }
    if (stage === round.lookup) {
      return {
        transform: slot,
        '--fx': `${VAULT_X}px`,
        '--fy': `${VAULT_Y}px`,
        '--tx': `${RIGHT_CHIP_X}px`,
        '--ty': `${slotY(i)}px`,
        animation: `chip-move 0.9s ease-in-out ${round.lookupDelay + 1.3 + i * 0.3}s both`,
      } as CSSProperties
    }
    return { transform: slot }
  }

  // Highlight while comparing: the same row in both sakene
  const compareHighlight: Highlight | undefined =
    scenario && compareRow >= 0
      ? {
          part: scenario.rows[compareRow],
          tiltak: 0,
          tone: scenario.newEvents.some((e) => rowOf(scenario, e) === compareRow) ? 'change' : 'same',
        }
      : undefined

  const incomingHighlight =
    stage === STEP.CREATE_EVENTS && created > 0
      ? highlightFor(EVENTS_V1[created - 1], SAK_V1)
      : compareHighlight && !scenario?.skipIncomingHighlight.includes(compareHighlight.part)
        ? compareHighlight
        : undefined

  const lookupRound = FETCH_ROUNDS.find((r) => r.lookup === stage)

  return (
    <>
      <svg className="wide" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
        {/* Events (drawn before the DB so they slide in/out from behind it) */}
        {CREATE_ROUNDS.map((round, r) =>
          round.events.map((e, i) => (
            <EventChip key={`created-${r}-${i}`} event={e} style={createdStyle(round, i)} active={stage === round.create && i === created - 1} />
          )),
        )}
        {FETCH_ROUNDS.map((round, r) =>
          isActive(stage, round.lookup, round.chipsExit)
            ? round.events.map((e, i) => (
                <EventChip
                  key={`fetched-${r}-${i}`}
                  event={e}
                  style={fetchedStyle(round, i)}
                  active={stage === round.rebuild && i === built - 1}
                />
              ))
            : null,
        )}

        {/* Toggle step: the ErSlettet events, then a sak built from them */}
        {isToggle &&
          TOGGLE_EVENTS.map((e, i) => (
            <EventChip
              key={`toggle-${i}`}
              event={e}
              active={i === toggled - 1}
              style={{ transform: at(RIGHT_CHIP_X, slotY(i)), animation: `appear 0.4s ${0.5 + i * 0.1}s both` }}
            />
          ))}
        {isToggle && (
          <SakCard
            key="toggle-card"
            x={RIGHT_CARD_X}
            y={CARD_Y}
            sak={visibleSak(toggleRaw)}
            slots={1}
            highlight={toggled > 0 ? highlightFor(TOGGLE_EVENTS[toggled - 1], toggleRaw) : undefined}
          />
        )}

        <Database label="Event-DB" opacity={isCompare ? 0 : 1} delay={isLookupAll ? 0.3 : 0} />

        <FlowArrow y={VIEW_H - 20} />

        {/* Incoming sak on the left (remounts, and slides in, when a new one arrives) */}
        <g key={current ? `sak-${current.start}` : 'sak-first'} className="slide-in">
          <SakCard x={LEFT_CARD_X} y={CARD_Y} sak={incoming} slots={1} highlight={incomingHighlight} />
        </g>

        {/* Sakene built from fetched events */}
        {FETCH_ROUNDS.map((round, r) => {
          if (!isActive(stage, round.lookup, round.cardExit)) return null
          const shown = stage === round.rebuild ? built : stage > round.rebuild ? round.events.length : 0
          const raw = buildSak(round.events, shown)
          const sak = visibleSak(raw)
          const slid = round.slideLeftAt !== undefined && stage >= round.slideLeftAt
          const highlight =
            stage === round.rebuild && built > 0
              ? highlightFor(round.events[built - 1], raw)
              : stage === round.slideLeftAt
                ? compareHighlight
                : undefined
          return (
            <SakCard
              key={`built-${r}`}
              x={slid ? EXISTING_CARD_X : RIGHT_CARD_X}
              y={CARD_Y}
              sak={sak}
              slots={round.slots}
              highlight={highlight}
              opacity={stage === round.cardExit ? 0 : 1}
            />
          )
        })}

        {stage === STEP.LOOKUP_EMPTY && <Lookup key={stage} sql={sql} result="Ingen treff" ok={false} />}
        {lookupRound && (
          <Lookup key={stage} sql={sql} result={`${lookupRound.events.length} treff`} ok delay={lookupRound.lookupDelay} />
        )}
      </svg>

      <StepControls stage={stage} total={CAPTIONS.length} caption={CAPTIONS[stage]} onChange={setStage} />
    </>
  )
}


