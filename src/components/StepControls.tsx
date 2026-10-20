type Props = { stage: number; total: number; caption: string; onChange: (stage: number) => void }

/** Caption plus back/next buttons. */
export default function StepControls({ stage, total, caption, onChange }: Props) {
  return (
    <>
      <div className="caption">{caption}</div>
      <div className="controls">
        <button disabled={stage === 0} onClick={() => onChange(stage - 1)}>← Back</button>
        <span>{stage + 1} / {total}</span>
        <button disabled={stage === total - 1} onClick={() => onChange(stage + 1)}>Next →</button>
      </div>
    </>
  )
}

