import type { StoreLocation } from '../api'

/**
 * "Kur novietot tukšo": asked when a toner or drum is marked used — the empty one is counted on the "Tukšie"
 * list (Vēsture) at the chosen place. The printer's own default place is pre-selected by the caller;
 * "neuzskaitīt" is for an empty that isn't kept (0 = not counted).
 */
export function EmptyPlace({ value, onChange, locations, drum }: {
  value: number; onChange: (id: number) => void; locations: StoreLocation[]; drum?: boolean
}) {
  return (
    <label>Kur novietot {drum ? 'tukšo drumu' : 'tukšo toneri'}
      <select value={value} onChange={(e) => onChange(+e.target.value)}>
        <option value={0}>– neuzskaitīt –</option>
        {locations.filter((l) => l.active || l.id === value).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  )
}
