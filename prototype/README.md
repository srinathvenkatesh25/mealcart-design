# MealCart prototype

**Live:** [srinathvenkatesh25.github.io/mealcart-design/prototype/](https://srinathvenkatesh25.github.io/mealcart-design/prototype/)

A clickable replay of a real MealCart run: 7 days of Mexican meals at 1,850 kcal and 80 g protein a
day, ending in a verified 14-item Kroger cart of $54.50 against an $80 budget. The meals, nutrition
numbers, grocery list, cart, swap result and USDA entries are all real output from the MVP. Feed
timing is shortened. No backend, no AI calls, no Instacart access.

## Open it

Use the live link, or open `index.html` directly in a browser. It works from the file system;
only the fonts come from the web.

## Using it

The dark bar at the top is outside the product:

- **Journey** jumps to a journey from the spec:

  | | Journey |
  |---|---|
  | J1 | Set targets |
  | J2 | Review and ask why |
  | J3 | Approve |
  | J4 | Shop, with pauses |
  | J5 | Check the cart and hand off |

- **Play as** picks one of the three personas. A guide in the side rail lists that persona's tasks,
  ticks each one off as you do it, and shows their success criteria at the end.
- **Failure** shows a failure flow:
  - the cart needs a look (a second recorded run)
  - every AI model is busy
  - Instacart delivers to a different ZIP
- **Dark / Light** switches the theme.

## What to look for

| | Where |
|---|---|
| Decision rights | Approve or cancel the list, swap a meal, untick an item, answer each pause, and check out yourself |
| Interrogation | Open a meal for its macros; **Why?** on an ingredient shows the USDA entry and the arithmetic; **Why this product?** in the cart; the store-ranking card; how the plan was checked |
| Trust cues | Rounding note, model-switch lines in the feed, AI usage line, need-vs-have for every item, estimate and estimated-weight badges, the verified stamp, the ZIP warning |

## Marks

- **Proposed** (dashed chip): designed in the spec, not yet in the MVP.
- **Scripted** (dotted chip): a pause the recorded run didn't hit, scripted so the journey can be
  shown. These are the Instacart code, the existing-cart question and the substitute question.
  The questions use the MVP's own wording.
- Only Monday dinner has a recorded swap. Other Swap buttons explain this.
- The cart is the recorded one, so plan changes you make here aren't reflected in it. The page says
  so when it applies.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | The MVP's own styles, plus prototype-only additions at the end |
| `app.js` | The scripted run |
| `data/run.json` | The exported run |
| `data/run.js` | The same data, loaded as a script so the page also works from the file system |
