# DadBuddy — product and UX review

DadBuddy started life as "Baby Log". Review of v1 against NHS guidance (nhs.uk, read 21 Nov 2026) and UK baby-care conventions,
with the decision taken for each finding. Each guidance figure in the app links back to the page listed here.

## Sources (nhs.uk, with each page's "last reviewed" date)

| Topic | Page | Reviewed |
|---|---|---|
| Breastfeeding: first few days (8–12+ feeds/24h, responsive feeding) | /baby/breastfeeding-and-bottle-feeding/breastfeeding/the-first-few-days/ | 14 Sep 2026 |
| Is my baby getting enough milk? (wet and dirty nappy counts) | /baby/breastfeeding-and-bottle-feeding/breastfeeding-problems/enough-milk/ | 30 Apr 2026 |
| Bottle feeding advice (responsive bottle feeding; no poo 2–3 days under 8 weeks) | /baby/breastfeeding-and-bottle-feeding/bottle-feeding/advice/ | 2 Apr 2024 |
| Formula milk questions (storage, "may not finish their bottle") | /baby/breastfeeding-and-bottle-feeding/bottle-feeding/formula-milk-questions/ | 8 Sep 2023 |
| Fever in children (38C threshold, under-3-months rule, medicines) | /conditions/fever-in-children/ | 3 Jan 2024 |
| How to take your baby's temperature (armpit, digital) | /baby/health/how-to-take-your-babys-temperature/ | 18 Jul 2023 |
| When to get urgent medical help (999/A&E list) | /baby/health/when-to-get-urgent-medical-help-for-babies-and-children-under-5/ | 6 Aug 2026 |
| Dehydration (fewer wet nappies, sunken fontanelle) | /conditions/dehydration/ | 1 May 2026 |
| Newborn jaundice (pale poo, dark pee) | /conditions/jaundice-newborn/ | 24 Mar 2026 |
| Reduce the risk of SIDS (safe sleep) | /baby/caring-for-a-newborn/reduce-the-risk-of-sudden-infant-death-syndrome/ | 25 Nov 2025 |
| Helping your baby to sleep (newborns ~18h/24h) | /baby/caring-for-a-newborn/helping-your-baby-to-sleep/ | 28 Jan 2025 |
| Vitamins for children (vitamin D 8.5–10µg from birth; >500ml formula exception) | /conditions/baby/weaning-and-feeding/vitamins-for-children/ | 30 May 2024 |

## Findings and decisions

### Guidance and safety

1. **"Next feed around 14:30" goes against NHS advice.** The NHS says to feed responsively, "as often as they want",
   and adds that a big feed doesn't mean a longer gap. A predicted feed time pushes parents towards a schedule.
   **Removed.** The app now shows time since the last feed and, in the first 6 weeks, feeds in the last 24h
   against the NHS rough guide (8–12 or more).
2. **There was no check that the baby is getting enough milk.** The NHS signs are nappy counts by age: 2–3 wet nappies
   in the first 48h; at least 6 heavy wet nappies a day from day 5; and from day 4, at least 2 soft yellow poos a day,
   each about the size of a £2 coin, for the first few weeks.
   **Added:** a baby profile (date of birth) and age-aware "Today's checks".
3. **Poo colour wasn't recorded.** The NHS jaundice page says pale, creamy poo needs an urgent GP or midwife appointment,
   or NHS 111 (keep a sample). **Added:** a poo colour picker on dirty nappies; pale poo raises an alert.
4. **Pee colour wasn't recorded.** Dark yellow or brown pee is an urgent-GP/111 sign (jaundice and dehydration pages).
   **Added** as an optional flag on wet nappies.
5. **No wet nappy for 12 hours** is on the NHS 999/A&E list. **Added** as an alert. Because the app can only see
   what's been logged, the wording asks parents to check, and the alert only appears once logging has covered 12 hours.
6. **No poo for 2–3 days in a baby under 8 weeks:** the NHS says talk to a midwife, health visitor or GP.
   **Added** as a check (48h, once logging covers 48h).
7. **There was no temperature log.** Fever is the main reason parents need age-specific thresholds: 38C or more under
   3 months, 39C or more at 3–6 months, and under 36C. **Added** a temperature entry. It reminds you to use a digital
   thermometer under the arm, and raises the NHS action for the baby's age. For 38C+ under 3 months, the NHS fever
   page says call 111 and the urgent-help page lists 999/A&E. The app shows the stricter (urgent-help) advice and names both.
8. **Vitamin D.** NHS: breastfed babies need a daily 8.5–10µg vitamin D supplement from birth; babies having more
   than 500ml of formula a day don't. **Added** a one-tap "Vitamin D given" entry and a daily check. The check stands
   down automatically when logged formula is over 500ml in 24h.
9. **There was no route to urgent help.** **Added** a Help tab: the NHS 999/A&E list for under-5s, NHS 111,
   the National Breastfeeding Helpline (0300 100 0212), safe sleep basics, fever how-to and formula safety,
   all linked to nhs.uk. Alerts link straight to `tel:999` / `tel:111`.
10. **Sleep wasn't tracked,** even though parents are asked about it constantly. **Added** a sleep timer and sleep per 24h,
    shown as information only (NHS: newborns sleep about 18h in 24h, and every baby has its own pattern).
    Starting a sleep shows the safe-sleep basics (on their back, feet to foot, clear flat cot, same room).
11. **Weight.** **Added** a weight entry (kg), with change since birth weight. The app makes no judgement about
    weight: that's the job of the Red Book and the health visitor.
12. **The app is not a medical device.** It says so in Help and in Settings: it records, it doesn't diagnose,
    and "Trust your instincts" (NHS).

### Language (UK)

13. "Diaper" → **"nappy"**. "Bottle (breast milk)" → **"Expressed milk"** (the NHS term). Times use the 24-hour
    en-GB format, so 03:10 and 15:10 can't be confused at night.

### UX

14. **Night use.** The dark theme is still a bright, cool UI at 3am. **Added** a warm, dim "Night light" theme.
    **Auto** mode switches to it from 21:00 to 07:00.
15. **The theme button** ("Auto / ☾ / ☀") was unclear. It now lives in Settings, with named options.
16. **One-handed use.** Primary buttons are at least 64px tall and spaced; labels are at least 13px; icons
    and text are used together (status is never shown by colour alone).
17. **Feed and sleep timers.** Starting a feed stops a running sleep (and the other way round), with a toast,
    so you can't end up with two timers by mistake.
18. **Age** shows in the header ("12 days old"), because NHS guidance is age-based and parents are asked this all the time.
19. **First run.** Onboarding asks for name, date of birth and (optionally) birth weight, so the checks work from the first day.
20. **Checks wait for enough data.** Each check only reports once logging has covered its whole window, so a family
    that started logging at lunchtime doesn't get "only 2 feeds in 24h".

### Found during v2 QA and fixed

21. A normal temperature re-check hid an earlier high reading. High readings now use the highest value in the last 6 hours.
    Low readings still use the newest value, because the NHS says to re-check a low reading.
22. The poo count could show "In line with guide" while a pale poo was logged. The check now names the flagged colour.
23. The "dark pee" box sat below the colour buttons, but tapping a colour logs straight away. The box now comes first.
24. The sleep card showed "40m" without saying whether that was awake or asleep. Its title now says "Awake for" or "Asleep for".
25. Contrast: white text on the timer panels, the 999 button in dark mode, the avatars, and the muted text in Light and
    Night light fell below WCAG AA. All text pairs now measure at least 4.5:1.
26. Night light timers were bright, solid panels. They're now dim, tinted panels with an accent outline.

### v3: installable app, offline logging, sync at home

27. **The app only worked while connected to home Wi-Fi.** Feeds and nappies happen at the GP, on walks and in the car.
    Phones now keep their own copy, log offline, and sync when they're back on home Wi-Fi. Installing needs HTTPS,
    so the PC issues a home certificate, restricted by name constraints to `baby.local`, its own `.local` name and private IPs.
    A step-by-step setup page walks through installing it on iPhone and Android.
28. **While apart, each phone only sees its own entries.** A "no wet nappy for 12 hours" alert or a low feed count could be
    wrong because the other parent logged it elsewhere. **Decision:** alerts and checks are never suppressed, because hiding
    a real alert is worse than showing one that's out of date. A note next to them says which phone's entries are missing and since when.
    The sync bar shows "Away from home", how many changes are waiting, and when the phone last synced.
29. **Conflicts.**
    - The same entry edited on both phones: the most recent edit wins.
    - Deletions are kept as tombstones, so a deleted entry never comes back.
    - Two timers started while apart (Mum starts a feed, Dad starts a sleep): the server ends the older one when the newer
      one started. This matches what the app does on one phone, and nothing logged offline is thrown away.
30. **Phones validate with the same rules as the server** (one shared `rules.js`), so mistakes are caught when typed rather
    than at sync time. If the server still refuses a change, the phone puts back the server's copy and says why.
31. **Changing the baby profile needs home Wi-Fi,** so the two phones never disagree about the date of birth, which the age-based
    checks depend on.

### v4: DadBuddy name, logo and friendlier interface

32. **Name and logo.** "DadBuddy": the app is a buddy for the parent on the night shift. The logo is a yellow D whose bowl hugs a
    sleeping baby. It's one simple shape, so it still reads at 48 px and as a maskable Android icon.
33. **Palette.** The v2 cream and terracotta looked like countless other apps. DadBuddy uses Cloud, Blueberry and Sunshine.
    Sunshine marks the one thing to tap (the main button and the current tab), always with Blueberry text (8.8:1).
    Feed, nappy and sleep keep their validated chart colours, so every screen colour-codes them the same way.
    Night light keeps its warm amber with no blue-white.
34. **Friendlier language.**
    - The header greets the parent by time of day ("Good evening, Mum", or "Night shift, Dad" after 9pm).
    - It says the baby's age as a sentence ("Ada is 12 days old").
    - Sign-in asks "Hi! Who's looking after Ada?"
    - Empty states say what to do next.
    - Headings are sentence case, with no all-caps labels.
35. **Easier tapping.** The log buttons are taller (92–96 px), with the icon in a round bubble of the category colour.
    On phones the status cards go two-up, so times like "2h 07m ago" never wrap.
36. **First run.** A sunny card asks you to "Tell DadBuddy about your little one". The checks need the date of birth to match
    NHS age bands, so this is the most important thing to set.
37. **Contrast** is re-measured for every new pair in all three themes. Every text pair is at least 4.5:1 and every icon at least 3:1.
    The setup page's green step badge got a dark tick in Dark mode, because white on that green measured 2.1:1.

### Verification
- `npm test`: 16 tests covering each NHS rule (age bands, data-coverage gating, 30-minute feed grouping, formula-only babies,
  vitamin D over 500 ml, temperature by age, re-checks, 12-hour no-wet, pale poo and dark pee, black poo by age,
  no poo for 2 days, alert ordering).
- API checks: migration from v1 (and re-running it), new entry types, validation, timer conflicts.
- Visual QA in Light, Dark and Night light with a seeded 12-day-old's last 30 hours. No console errors.
- v3: `npm test` has 30 tests, including the sync protocol against a real server:
  - replaying an op changes nothing
  - last write wins
  - tombstones
  - the since cursor
  - timer reconciliation
  - refused changes
  - HTTPS with the home certificate
  - HTTP redirects
  - the v2 → v3 upgrade with backup
- v3 browser test, with the live server stopped to simulate leaving home:
  - Away: the app opened from cache, logged a feed, a dirty nappy and an edit, and showed the away bar and the note on checks.
  - Back home: the queued changes went up, the other phone's entries came down, and the overlapping timer was ended.
  - No console errors.
  - Chrome offered to install the app.

### Kept from v1
One-tap logging with Undo, live sync between phones, editing and deleting any entry, CSV export,
counting feeds less than 30 minutes apart as one feed, and local-only data.
