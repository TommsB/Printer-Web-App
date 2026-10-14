import { Icon } from '../icons'
import { ActionMenu } from './TonerRow'

/**
 * Phones only (CSS .co-btn): the company filter as a round button with a menu, like Skats and Kārtošana — on
 * desktop the same choice is the "Visi / Tenapors / …" switch. While a company is picked (anything but Visi)
 * the button is marked in the accent colour, so a filtered list is never mistaken for the whole one.
 */
export function CompanyMenu({ value, companies, onChange }: { value: string; companies: string[]; onChange: (c: string) => void }) {
  return (
    <ActionMenu code="Uzņēmums" title="Uzņēmums"
      button={{ className: value ? 'icon-btn co-btn co-on' : 'icon-btn co-btn', icon: Icon.building(18), label: `Uzņēmums: ${value || 'visi'}`, title: 'Uzņēmums' }}
      items={[
        { label: 'Visi', checked: value === '', run: () => onChange('') },
        ...companies.map((c) => ({ label: c, checked: value === c, run: () => onChange(c) })),
      ]} />
  )
}
