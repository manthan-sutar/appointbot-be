# Session `temp_data` keys by state

`sessions.temp_data` (exposed as `session.temp` in code) holds **booking-flow context** until the user finishes or resets. Keys are merged with `{ ...temp, ... }` on transitions; not every key is present in every session.

| State | Typical keys | Purpose |
| ----- | ------------ | ------- |
| `IDLE` | (empty or stale) | No active flow. |
| `AWAITING_SERVICE` | `services` | Cached service list for matching. |
| `AWAITING_DATE` | `serviceId`, `serviceName`, `durationMinutes`, `price`, `staffId`, `staffName`, `lockStaff`, `notes` | Chosen service + optional locked staff. |
| `AWAITING_TIME` | Above + `date`, `displaySlots` | Date chosen; `displaySlots` is the curated list shown to the user (number picks map here). |
| `AWAITING_STAFF` | Above + `staffList` | Multiple staff; user picks one. |
| `AWAITING_NAME` | Above + `time`, `pendingBooking` | Slot chosen; collecting name if missing. |
| `AWAITING_CONFIRMATION` | Above + `customerName`, `pendingBooking` | Ready for yes/no. |
| `AWAITING_CANCEL_WHICH` | `appointments` | List of bookings to disambiguate cancel. |
| `AWAITING_RESCHEDULE_WHICH` | `appointments` | Same for reschedule. |
| `AWAITING_RESCHEDULE_DATE` | `rescheduleAppt`, `displaySlots`, plus service/staff context as set | Picking new date for reschedule. |
| `AWAITING_RESCHEDULE_TIME` | Above + `rescheduleDate`, `displaySlots` | Picking new time. |
| `AWAITING_RESCHEDULE_CONFIRM` | `rescheduleAppt`, `rescheduleDate`, `rescheduleTime` | Confirm reschedule. |
| `AWAITING_HANDOFF` | (business-specific) | Human handoff flow. |

**Hygiene notes**

- On **reset** / **start over**, `temp_data` should be cleared (see `resetSession` / fresh `updateSession` to `IDLE`).
- When **changing date** mid-flow, code clears `time` and refreshes `displaySlots` as needed so stale slot indices are not reused.
- **`displaySlots`** must always correspond to the message that listed numbered options; do not reuse across different dates without recomputing.
