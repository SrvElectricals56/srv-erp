# Visit reward points

New visits start their reward timer after a successful shop photo upload. The timer persists across photo retakes. Points are calculated once when Submit Visit completes; older visits without a reward timer are unchanged.

Time near the dealer is verified using GPS samples within 500 metres of the uploaded photo location. Intervals with missing, imprecise, outside, or rejected samples are excluded. Each consecutive interval must fit the configured GPS maximum gap.

| Time near dealer | -1 point below | 0 points | Positive points |
| --- | ---: | ---: | ---: |
| Up to 30 minutes | ₹20,000 | ₹20,000–39,999.99 | 1 point per ₹40,000 |
| Over 30 through 60 minutes | ₹75,000 | ₹75,000–1,49,999.99 | 2 points per ₹1,50,000 |
| Over 60 through 120 minutes | ₹2,00,000 | ₹2,00,000–2,99,999.99 | 3 points per ₹3,00,000 |
| Over 120 through 180 minutes | 3 points per ₹3,00,000 | ₹3,00,000–3,99,999.99 | 4 points per ₹4,00,000 |
| Over 180 minutes | 4 points per ₹4,00,000 | ₹4,00,000–4,99,999.99 | 5 points per ₹5,00,000 |

Positive points equal whole multiples of the qualifying amount multiplied by the band’s points (1, 2, 3, 4 or 5). Remainders do not earn points. Exactly 30, 60, 120 and 180 minutes belong to the preceding band. Existing submitted visits retain their original calculation; new submissions use version 4.

Only orders linked to this visit, for this dealer, created during the photo-to-submission interval and not cancelled at submission count. Saved draft orders count because Make Order may use an approval workflow. Foreign-currency orders count using their company-currency amount only when that currency is INR.

Each completed visit stores its verified duration, order amount, order list, threshold, penalty and points as a submission snapshot. Later order edits do not change this snapshot. The header displays the signed sum of completed visit points for the signed-in account.
