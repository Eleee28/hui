# Contributions → Calendar

Run against `node e2e/visual-verification.mjs launch --branch <branch>
--activity-fixture`. `e2e/fixtures/activity-fixture.ts` seeds the isolated store before
the gateway starts: ten synthetic Durable sessions worked through the week
before the current one, in five projects (directories under the workspace:
checkout-api, ios-app, marketing-site, evals, infra) and five sidebar groups
(Payments, Growth, AI, Mobile, Platform), with parallel work on Monday,
Wednesday and Thursday and a Wednesday night from 9 PM to 1:55 AM; one more
session worked in the last few hours of this week; and one subagent session,
which the calendar leaves out. No operator session or PI transcript is read.

## Journeys

1. Sidebar **Contributions**, then the **Calendar** tab: the heading shows the
   current week (Monday to Sunday), *This week* and *Next week* are disabled,
   *Group by* shows **Project** pressed, today's column is tinted with a line at
   the current time, and the recent *hui* blocks are drawn. Reloading keeps the
   tab and the grouping.
2. **Previous week**, grouped by **Project**: 10 sessions, 20 blocks and "up to 2
   at once". The side panel reads "29h 25m across 5 projects", "Recorded
   activity, parallel time counted once · 32h 20m of session time", then
   checkout-api 11h 05m, ios-app 8h 05m, marketing-site 5h 45m, evals 4h 40m and
   infra 2h 45m. *Hours per day* labels Wednesday (8h 45m) as the busiest. Wednesday night is
   one *checkout-api* block from 9:00 PM to 1:55 AM: its card lists *Webhook
   double charge* (3h 15m) and *Hotfix: currency rounding* (1h 20m) with their
   first messages, 4h 35m of recorded activity (not 4h 55m, since the pause is
   not work), and "11h 05m this week". Clicking a session there opens it.
3. Activating *checkout-api* in the side list shows only its blocks at full day-column width and lists
   its sessions (*Retry-safe checkout* 5h 05m, *Webhook double charge* 4h 40m,
   *Hotfix: currency rounding* 1h 20m); *Show all* or activating it again restores
   the grid. Going to a week without that item clears focus.
4. **Group**: "29h 25m across 5 groups", Payments 13h 05m first (checkout-api
   plus *Receipt screen* from ios-app).
5. **Session**: 21 blocks, *Pricing page redesign* (5h 45m) first; the 9th and
   10th sessions use the shaded colors. The Wednesday night *Webhook double
   charge* block's card shows "Wed, Sep 30 · 10:40 PM – 1:55 AM · 3h 15m", the
   *checkout-api* chip, *Payments*, `claude-opus-5-5`, the first message "Store
   processed webhook event ids and add the failing test" and "4h 40m this
   week". Escape closes it and returns focus to the block; **Open session**
   opens `/sessions/e2e-activity-2` with the seeded transcript.
6. Real activity: start a new session in the receipt's workspace and send
   `E2E_RICH`. Back on the Calendar tab it is listed in this week under the
   workspace's own name, with a block at the current time and its first message.
7. Select **Group**, reload, and confirm **Group** remains selected without
   leaving Calendar. A week before the fixture shows an empty state, and
   **Next week** restores the data. The weekly total stays the same in all modes.
8. Activate Wednesday's date heading (click or Enter/Space). **Day** shows
   "Wed, Sep 30" as one full-width column, five sessions, four grouped blocks,
   "up to 2 at once", 8h 45m of recorded activity and 10h 45m of session time.
   Project totals are checkout-api 6h 55m, ios-app 2h 30m and marketing-site
   1h 20m. The card's footer says "this day" and *Hours per day* is absent.
   Changing Group/Session keeps the same day and recorded total. Item focus
   remains usable and **Show all** restores that day's other items.
9. **Previous day** keeps keyboard focus on the arrow, so another Enter goes
   back another day. **Next day** crosses Sunday to Monday; **Back to week**
   returns to that Monday's week with the grouping preserved. **Today** shows
   the current activity day and disables Today/Next day. Future dates in Week
   are disabled. A day before the fixture shows "No HUI session activity this
   day.". On a failed navigation, the previously loaded date/view and data
   remain together with an error; Retry/Refresh can read again.
10. 390×844: the heading, summary, *Group by* and date controls wrap; Week
   scrolls sideways with pinned hour labels; Day fits the available width
   without keeping the seven-column minimum. Cards and item breakdowns work
   in both views. Repeat the day selection/return and card flow in light/dark
   at 1440×900 and 390×844; also check the card at 844×390.

`?from=` empty, `1e3`, `0x10`, negative or more than 31 days apart return 400
(`server/sessions/activity.test.ts`).
