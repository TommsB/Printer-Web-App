"""Pages printed from a printer's total page counter (one reading per day, page_counts).

The counter only goes up, except:
- a glitch: one low reading, e.g. 0 while the printer wakes from sleep (50000, 0, 50010). Counting from the low
  value would add the whole counter at once (50010 pages), so a drop is held back for one reading: if the next one
  is back up, the drop was a glitch and only the real growth counts (10).
- a reset: the printer was replaced or its counter reset (50000, 120, 300). Two low readings in a row confirm it,
  and counting goes on from the new, low counter (180).
Zero or missing readings never count as a reading.
"""


def steps(values: list[int | None]) -> list[int | None]:
    """For each reading (oldest first), the pages it adds; None while there is nothing to count from yet (before the
    first real reading — and for that first reading itself)."""
    out: list[int | None] = []
    base: int | None = None  # the last counter value trusted
    pending: int | None = None  # a lower value seen once: a glitch or a reset, decided by the next reading
    for v in values:
        if v is None or v <= 0:
            out.append(None if base is None else 0)
            continue
        if base is None:
            base = v
            out.append(None)
        elif v >= base:  # normal growth; also the reading after a glitch
            out.append(v - base)
            base, pending = v, None
        elif pending is None:  # lower than before: hold it back
            pending = v
            out.append(0)
        else:  # lower twice in a row: a real reset, count from the new counter
            out.append(max(0, v - pending))
            base, pending = v, None
    return out


def total(values: list[int | None]) -> int:
    """Pages printed across the readings."""
    return sum(s for s in steps(values) if s)
