> A wake event is a latency hint. The row is the truth, and a status that says push must be subscribed right now, not at some earlier moment the process remembers.

1. Read the row.
2. Compare it with what the status printed.
3. If they differ, the row wins and the status is a defect.
