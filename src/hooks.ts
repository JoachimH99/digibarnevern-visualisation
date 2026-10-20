import { useEffect, useState } from 'react'

/** Step state controlled with the left/right arrow keys. */
export function useStepNavigation(total: number) {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setStage((s) => Math.min(s + 1, total - 1))
      if (e.key === 'ArrowLeft') setStage((s) => Math.max(s - 1, 0))
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [total])
  return [stage, setStage] as const
}

/**
 * Counts from 0 up to `total` while `active` is true, one tick per `interval` ms
 * (first tick after `startDelay` ms). Resets to 0 whenever `active` changes.
 * With `loopPause` it starts over from 0 that many ms after the last tick, and keeps looping.
 * Later rounds skip `startDelay`: the first tick comes one `interval` after the restart.
 */
export function useSequence(active: boolean, total: number, startDelay = 600, interval = 900, loopPause?: number) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    if (!active) return
    const ids: number[] = []
    const run = (delay: number) => {
      setN(0)
      for (let i = 0; i < total; i++) ids.push(window.setTimeout(() => setN(i + 1), delay + i * interval))
      if (loopPause !== undefined) {
        ids.push(window.setTimeout(() => run(interval), delay + (total - 1) * interval + loopPause))
      }
    }
    run(startDelay)
    return () => ids.forEach(clearTimeout)
  }, [active, total, startDelay, interval, loopPause])
  return n
}
