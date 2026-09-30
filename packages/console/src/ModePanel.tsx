import { useId, useState } from 'react'
import type { ModePanel, PanelAction, PanelInput, PanelRow } from '@animatus/protocol'
import { Pill } from './components.tsx'

/**
 * What a mode shows and offers, drawn without knowing the mode: a status line, facts, a picture, buttons (with
 * inputs) and lists whose rows have buttons of their own. Whatever is pressed goes to `onAct` with the action's id,
 * the row's id (for a row button) and the values of the inputs.
 */
export interface ModePanelProps {
  panel: ModePanel
  /** True while some call for this page is in flight: the buttons wait. */
  busy: boolean
  /** Where an asset URL of the stage server lives (a picture the mode shows). */
  assetBase?: string
  onAct(params: Record<string, string | number | boolean>): void
}

type Values = Record<string, string | number | boolean>

/** The value an input starts with, as a state value. */
function initialValue(input: PanelInput): string | number | boolean {
  if (input.value !== undefined) return input.value
  if (input.kind === 'toggle') return false
  if (input.kind === 'number') return input.min ?? 0
  return input.kind === 'select' ? (input.options?.[0]?.value ?? '') : ''
}

function InputField({
  input,
  value,
  onChange,
}: {
  input: PanelInput
  value: string | number | boolean
  onChange(v: string | number | boolean): void
}) {
  const id = useId()
  switch (input.kind) {
    case 'toggle':
      return (
        <span className="check">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <label htmlFor={id}>{input.label}</label>
        </span>
      )
    case 'select':
      return (
        <span className="field">
          <label htmlFor={id}>{input.label}</label>
          <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {(input.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </span>
      )
    case 'number':
      return (
        <span className="field">
          <label htmlFor={id}>{input.label}</label>
          <input
            id={id}
            type="number"
            value={typeof value === 'number' ? value : String(value)}
            {...(input.min !== undefined ? { min: input.min } : {})}
            {...(input.max !== undefined ? { max: input.max } : {})}
            {...(input.step !== undefined ? { step: input.step } : {})}
            onChange={(e) => {
              const n = e.target.valueAsNumber
              onChange(Number.isNaN(n) ? e.target.value : n)
            }}
          />
        </span>
      )
    default:
      return (
        <span className="field">
          <label htmlFor={id}>{input.label}</label>
          <input
            id={id}
            type="text"
            value={String(value)}
            {...(input.placeholder ? { placeholder: input.placeholder } : {})}
            onChange={(e) => onChange(e.target.value)}
          />
        </span>
      )
  }
}

/** One button; with inputs it is a small form that sends what the fields hold. */
function ActionButton({
  action,
  rowId,
  busy,
  onAct,
}: {
  action: PanelAction
  rowId?: string
  busy: boolean
  onAct(params: Values): void
}) {
  const whyId = useId()
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(action.inputs.map((i) => [i.name, initialValue(i)]))
  )
  const off = action.disabled !== undefined
  function submit() {
    if (action.confirm && !window.confirm(action.confirm)) return
    onAct({ action: action.id, ...(rowId !== undefined ? { row: rowId } : {}), ...values })
  }
  return (
    <span className="panel-action">
      {action.inputs.length > 0 ? (
        <span className="panel-inputs">
          {action.inputs.map((input) => (
            <InputField
              key={input.name}
              input={input}
              value={values[input.name] ?? initialValue(input)}
              onChange={(v) => setValues((old) => ({ ...old, [input.name]: v }))}
            />
          ))}
        </span>
      ) : null}
      <button
        type="button"
        disabled={busy || off}
        {...(off ? { title: action.disabled, 'aria-describedby': whyId } : {})}
        onClick={submit}
      >
        {action.label}
      </button>
      {off ? (
        <span className="muted small" id={whyId}>
          {action.disabled}
        </span>
      ) : null}
    </span>
  )
}

function Row({ row, busy, onAct }: { row: PanelRow; busy: boolean; onAct(params: Values): void }) {
  return (
    <li className={row.active ? 'panel-row panel-row-active' : 'panel-row'}>
      <span className="panel-row-text">
        <strong>{row.text}</strong>
        {row.active ? <Pill tone="ok">now</Pill> : null}
        {row.detail ? <span className="muted small"> {row.detail}</span> : null}
      </span>
      <span className="panel-row-actions">
        {row.actions.map((a) => (
          <ActionButton key={a.id} action={a} rowId={row.id} busy={busy} onAct={onAct} />
        ))}
      </span>
    </li>
  )
}

export function ModePanelView({ panel, busy, assetBase, onAct }: ModePanelProps) {
  const image = panel.image
    ? panel.image.startsWith('/') && assetBase
      ? `${assetBase}${panel.image}`
      : panel.image
    : undefined
  return (
    <div className="mode-panel" aria-label="Mode details">
      {panel.status ? <p className="panel-status">{panel.status}</p> : null}
      {panel.facts.length > 0 ? (
        <dl className="facts">
          {panel.facts.map((f, i) => (
            <div className="fact" key={`${f.label}-${i}`}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {image ? <img className="panel-image" src={image} alt="What the mode shows now" /> : null}
      {panel.actions.length > 0 ? (
        <div className="panel-actions">
          {panel.actions.map((a) => (
            <ActionButton key={a.id} action={a} busy={busy} onAct={onAct} />
          ))}
        </div>
      ) : null}
      {panel.sections.map((s, i) => (
        <section className="panel-section" key={`${s.title}-${i}`}>
          <h4>{s.title}</h4>
          {s.rows.length === 0 ? <p className="muted small">{s.empty ?? 'Nothing here.'}</p> : null}
          {s.rows.length > 0 ? (
            <ul className="plain panel-rows">
              {s.rows.map((row) => (
                <Row key={row.id} row={row} busy={busy} onAct={onAct} />
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  )
}
