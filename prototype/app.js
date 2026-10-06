/* MealCart prototype: a scripted run over a sample week (data/run.js).
   Timing is shortened; nothing is sent anywhere. */

"use strict";

const RUN = window.RUN;
const $ = (sel, root = document) => root.querySelector(sel);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- Formatting ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nice = (s) => s.replace(/_/g, " ");
const kcal = (n) => Math.round(n).toLocaleString("en-US");
const g = (n) => `${Math.round(n)} g`;
const usd = (n) => `$${n.toFixed(2)}`;
const signed = (n, unit = "") => {
  const r = Math.round(n * 10) / 10;
  const shown = Math.abs(r) >= 10 || Number.isInteger(r) ? Math.round(Math.abs(r)) : Math.abs(r);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${shown}${unit}`;
};
const SLOT = { breakfast: "Breakfast", mid_morning: "Snack", lunch: "Lunch", evening: "Snack", dinner: "Dinner" };
const STEP = {
  intake: "Targets", plan: "Planning", solve: "Portions", validate: "Checks", repair: "Fixing",
  consolidate: "List", swap: "Swap", shop: "Instacart", model: "AI model",
};

// ---------- Personas (the team's three) and what each one tries ----------

const PERSONAS = {
  planner: {
    name: "Always-on-the-Go Planner",
    model: "“An assistant that does the planning so I don't have to think.”",
    start: "J1",
    tasks: [
      ["planned", "Generate a quick, realistic weekly plan: press Plan my week"],
      ["time", "Find fast-prep meals: open a meal and read its time check"],
      ["swap", "Adjust conversationally: Swap Monday dinner and say why"],
      ["approved", "Approve with one decision: Fill my cart"],
    ],
    success: "Less time planning, meals that fit the schedule, fewer decisions.",
  },
  shopper: {
    name: "Budget-Savvy Shopper",
    model: "“A cart builder I audit before money is spent.”",
    start: "J1",
    tasks: [
      ["planned", "Set a weekly budget, then Plan my week"],
      ["untick", "Avoid unnecessary purchases: untick something you have"],
      ["approved", "Check the estimate against the budget, then Fill my cart"],
      ["product", "Audit the cart: open Why this product? and the left-over column"],
    ],
    success: "Cart within budget, nothing unnecessary, less food wasted.",
  },
  dieter: {
    name: "On-and-Off Dieter",
    model: "“A coach that nudges, not a strict diet.”",
    start: "J2",
    tasks: [
      ["open", "Familiar foods, honest numbers: open any meal"],
      ["usda", "Ask where a number comes from: press Why? on an ingredient"],
      ["gradual", "Try this week's one small change"],
    ],
    success: "Manageable changes without restrictive dieting; easier to stick with.",
  },
};

// ---------- State ----------

const FRESH_FORM = () => ({
  mode: "form",
  calories: RUN.spec.macros.calories, protein: RUN.spec.macros.protein_g, days: RUN.spec.days,
  zip: "", budget: RUN.spec.budget_weekly_usd, cuisines: RUN.spec.cuisines.join(", "),
  dislikes: RUN.spec.dislikes.join(", "), allergies: "", restrictions: [...RUN.spec.dietary_restrictions],
  minutes: RUN.spec.max_prep_minutes, equipment: [...RUN.spec.equipment], pantry: RUN.spec.pantry.join(", "),
  words: "",
});

let S;
let timers = [];

function reset() {
  timers.forEach(clearTimeout);
  timers = [];
  S = {
    stage: "form",                 // form | planning | review | shopping | cart | failed
    form: FRESH_FORM(),
    formError: "",
    plan: clone(RUN.plan), perDay: clone(RUN.per_day), perMeal: clone(RUN.per_meal),
    unticked: new Set(),
    feed: [],                      // oldest first; shown newest first
    working: false,
    question: null,
    open: new Set(), why: new Set(), swapping: null, swapNote: "",
    changedMeals: new Set(),
    swapped: false, gradual: "offer",
    attention: false, zipMismatch: false, failure: null,
    met: S ? S.met : new Set(),
    persona: S ? S.persona : "",
  };
}

const say = (node, message) => { S.feed.push({ node, message }); };
const later = (ms, fn) => { timers.push(setTimeout(() => { fn(); render(); }, ms)); };
function script(lines, gap, done) {
  S.working = true;
  lines.forEach(([node, msg], i) => later(gap * (i + 1), () => say(node, msg)));
  later(gap * (lines.length + 1), () => { S.working = false; done(); });
}
function meet(key) {
  if (!S.met.has(key)) { S.met.add(key); }
}

// ---------- Derived numbers ----------

const items = () => RUN.grocery_list.items;
const keptItems = () => items().filter((i) => !S.unticked.has(i.name));
// Price memory: estimates come from prices seen in the last cart.
const lastPrice = (name) => RUN.cart.lines.filter((l) => l.grocery_item === name).reduce((s, l) => s + l.line_total_usd, 0);
const estimate = () => keptItems().reduce((s, i) => s + lastPrice(i.name), 0);
const budget = () => Number(S.form.budget) || null;
const usda = (name) => RUN.usda[name];

// Realistic minimum cooking times for slow foods.
const TIME_RULES = [
  { terms: ["brown_rice"], min: 30, pc: 20 },
  { terms: ["rice"], min: 15, exclude: ["flour", "noodle", "vinegar", "bran", "milk"] },
  { terms: ["ground_chicken"], min: 10 },
  { terms: ["chicken"], min: 15, exclude: ["ground", "broth", "stock", "cooked"] },
  { terms: ["potato"], min: 15, exclude: ["chip", "flour", "starch"] },
];
function timeFloor(meal) {
  const pc = RUN.spec.equipment.includes("pressure_cooker");
  let floor = 0, because = null;
  for (const ing of meal.ingredients) {
    for (const r of TIME_RULES) {
      if ((r.exclude || []).some((x) => ing.name.includes(x))) continue;
      if (!r.terms.some((t) => ing.name.includes(t))) continue;
      const m = pc && r.pc ? r.pc : r.min;
      if (m > floor) { floor = m; because = ing.name; }
      break;
    }
  }
  return { floor, because };
}

// ---------- Journeys ----------

const PLAN_LINES = [
  ["plan", "Planning 7 days…"],
  ["model", "gemini-3.8-flash: quota used up, resets in 6h12m. Switching to gemini-3.7-flash"],
  ["model", "gemini-3.7-flash: quota used up, resets in 6h12m. Switching to gemini-3.6-flash"],
  ["solve", "Portions sized to hit calories and protein"],
  ["validate", "Plan passed every check"],
  ["consolidate", "Grocery list ready: 14 items"],
];

function startPlanning() {
  S.stage = "planning";
  S.feed = [];
  if (S.failure === "quota") {
    script([
      ["plan", "Planning 7 days…"],
      ["model", "gemini-3.8-flash: quota used up. Switching to gemini-3.7-flash"],
      ["model", "gemini-3.7-flash: quota used up. Switching to gemini-3.6-flash"],
      ["model", "gemini-3.6-flash: quota used up. Switching to gemini-3.5-flash"],
      ["model", "gemini-3.5-flash: quota used up. Switching to gpt-oss-120b (Groq)"],
    ], 500, () => { S.stage = "failed"; });
    return;
  }
  script(PLAN_LINES, 550, () => { meet("planned"); toReview(); });
}

function toReview() {
  S.stage = "review";
  S.question = { kind: "plan_approval" };
}

function jump(journey) {
  const keep = { persona: S.persona, met: S.met, failure: $("#failure").value || null };
  reset();
  Object.assign(S, keep);
  if (journey === "J1") { S.stage = "form"; }
  else {
    S.form.zip = S.failure === "zip" ? "54321" : RUN.spec.zip_code;
    PLAN_LINES.forEach(([n, m]) => say(n, m));
    toReview();
    if (journey === "J4") { startShopping(); }
    if (journey === "J5") { shopLines().forEach(([n, m]) => say(n, m)); finishCart(); }
  }
  document.querySelectorAll("[data-journey]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.journey === journey)));
  render();
  const target = journey === "J3" ? $("#question") : $("#content h1");
  if (target) { target.setAttribute("tabindex", "-1"); target.focus(); target.scrollIntoView({ block: "center" }); }
  else { window.scrollTo(0, 0); }
}

function shopLines() {
  const lines = [["shop", "Opening Instacart…"]];
  if (S.form.zip !== RUN.spec.zip_code) {
    lines.push(["shop", `Instacart is set to deliver to ${RUN.spec.zip_code}, not your ZIP ${S.form.zip}. Stores and prices are for ${RUN.spec.zip_code}. To shop for ${S.form.zip}, change the delivery address in Instacart and start again.`]);
  }
  lines.push(
    ["shop", "Kroger stocks 6/6 hard-to-find items (chicken thigh, rolled oats, peanut butter, whole wheat bread, chili powder, cumin powder)"],
    ["shop", "Walmart stocks 5/6 hard-to-find items (chicken thigh, rolled oats, peanut butter, whole wheat bread, chili powder)"],
    ["shop", "Shopping at Kroger"],
  );
  RUN.cart.lines.forEach((l) => lines.push(["shop", `Added: ${l.product_name} (${l.pack_size}) × ${l.packs} — ${usd(l.line_total_usd)}`]));
  lines.push(["shop", "Read the cart back: 14 of 14 items covered"]);
  return lines;
}

function startShopping() {
  S.stage = "shopping";
  S.question = null;
  S.zipMismatch = S.form.zip !== RUN.spec.zip_code;
  meet("approved");
  S.working = true;
  later(400, () => say("shop", "Opening Instacart…"));
  later(900, () => { S.working = false; S.question = { kind: "email_code" }; });
}

// Called as each scripted pause is answered.
function continueShopping(after) {
  S.question = null;
  S.working = true;
  const lines = shopLines().slice(1);
  if (after === "code") {
    const store = lines.findIndex((l) => l[1] === "Shopping at Kroger");
    script([["shop", "Signed in"], ...lines.slice(0, store + 1)], 450, () => {
      S.question = { kind: "cart_clear_approval" };
    });
  } else if (after === "clear") {
    const adds = lines.filter((l) => l[1].startsWith("Added"));
    script(adds.slice(0, 9), 220, () => { S.question = { kind: "substitution_approval" }; });
  } else if (after === "sub") {
    const rest = lines.filter((l) => l[1].startsWith("Added")).slice(9);
    script([...rest, lines[lines.length - 1]], 220, finishCart);
  }
}

function finishCart() {
  S.stage = "cart";
  S.question = null;
  S.working = false;
  S.attention = S.failure === "attention";
  S.zipMismatch = S.form.zip !== RUN.spec.zip_code;
}

// ---------- Rendering: content ----------

function stagesHtml() {
  const at = { form: 0, planning: 1, review: 2, failed: 1, shopping: 3, cart: 3 }[S.stage];
  document.querySelectorAll("#stages li").forEach((li, i) => {
    li.className = i < at || (S.stage === "cart" && i === 3) ? "done" : "";
    if (i === at && S.stage !== "cart") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
}

function formHtml() {
  const f = S.form;
  const chips = (name, options, chosen) => options.map((o) => `
    <label class="chip"><input type="checkbox" data-chip="${name}" value="${o}" ${chosen.includes(o) ? "checked" : ""}>${nice(o)}</label>`).join("");
  const words = `
    <label class="field field-wide"><span>Describe your week</span>
      <textarea rows="5" data-f="words" placeholder="1,850 calories and 80 g protein a day, Mexican food with chicken, halal, nothing over 30 minutes, ZIP 12345, $80 budget">${esc(f.words)}</textarea>
      <small>One AI call turns this into the same preferences as the form. Include your ZIP.</small>
    </label>`;
  const form = `
    <fieldset class="targets"><legend>Daily targets</legend>
      <label class="field target"><span>Calories</span><input inputmode="numeric" data-f="calories" value="${esc(f.calories)}" aria-describedby="t-help"></label>
      <label class="field target"><span>Protein (g)</span><input inputmode="numeric" data-f="protein" value="${esc(f.protein)}"></label>
    </fieldset>
    <p class="fine" id="t-help">Only calories and protein are targets. Carbs and fat are shown, not limited.</p>
    <fieldset><legend>The week</legend><div class="grid">
      <label class="field"><span>Days</span><input inputmode="numeric" data-f="days" value="${esc(f.days)}"></label>
      <label class="field"><span>ZIP code</span><input inputmode="numeric" maxlength="5" autocomplete="postal-code" data-f="zip" data-k="zip" value="${esc(f.zip)}" required aria-describedby="zip-help">
        <small id="zip-help">Checked against Instacart's delivery address.</small></label>
      <label class="field"><span>Weekly budget ($) <em>optional</em></span><input inputmode="decimal" data-f="budget" value="${esc(f.budget)}"></label>
      <label class="field field-wide"><span>Cuisines</span><input data-f="cuisines" value="${esc(f.cuisines)}"></label>
    </div></fieldset>
    <fieldset><legend>Never use</legend><div class="grid">
      <label class="field"><span>Dislikes</span><input data-f="dislikes" value="${esc(f.dislikes)}"></label>
      <label class="field"><span>Allergies</span><input data-f="allergies" value="${esc(f.allergies)}" placeholder="none"></label>
      <div class="field field-wide"><span>Restrictions</span><div class="chips">${chips("restrictions", ["vegetarian", "vegan", "halal", "kosher", "gluten_free", "dairy_free"], f.restrictions)}</div></div>
    </div></fieldset>
    <fieldset><legend>Kitchen</legend><div class="grid">
      <label class="field"><span>Max minutes per meal</span><input inputmode="numeric" data-f="minutes" value="${esc(f.minutes)}"></label>
      <label class="field"><span>Effort</span><select><option>Low to moderate</option><option>Low</option><option>Any</option></select></label>
      <label class="field"><span>Cooking skill</span><select><option>Basic</option><option>Comfortable</option></select></label>
      <div class="field field-wide"><span>Equipment</span><div class="chips">${chips("equipment", ["stove", "microwave", "oven", "rice_cooker", "blender", "pressure_cooker", "air_fryer"], f.equipment)}</div></div>
      <label class="field field-wide"><span>Already in your pantry <em>never bought</em></span><input data-f="pantry" value="${esc(f.pantry)}"></label>
    </div></fieldset>`;
  return `
    <section class="hero">
      <h1>A week of meals that hits your numbers.</h1>
      <p>Set calories and protein. MealCart plans the week, checks every day against USDA data, and fills your Instacart cart. You check out yourself.</p>
    </section>
    <form class="spec" id="spec" novalidate>
      <div class="spec-tabs" role="tablist" aria-label="How to give your preferences">
        <button type="button" role="tab" data-mode="form" aria-selected="${f.mode === "form"}">Set targets</button>
        <button type="button" role="tab" data-mode="words" aria-selected="${f.mode === "words"}">Describe in words</button>
      </div>
      ${f.mode === "form" ? form : words}
      ${S.formError ? `<p class="form-error" role="alert">${esc(S.formError)}</p>` : ""}
      <button class="btn btn-primary btn-large" type="submit">Plan my week</button>
    </form>`;
}

function planningHtml() {
  return `
    <section class="hero hero-run"><h1>Planning your week…</h1>
      <p>One AI call plans all 7 days; then Python sizes the portions and checks them. About a minute in the real app.</p></section>
    <div class="placeholder">${Array.from({ length: 7 }, () => '<div class="label label-ghost"></div>').join("")}</div>`;
}

function whyUsda(name, grams, row) {
  const u = usda(name);
  if (!u || !row) return "";
  const per = u.per_100g;
  return `<div class="why-panel" id="why-${esc(name)}">
    <b>${esc(u.description)}</b>, USDA FoodData Central #${u.fdc_id}
    <span class="calc">${Math.round(grams)} g × ${per.calories} kcal / 100 g = ${kcal(row.calories)} kcal</span>
    <span class="calc">${Math.round(grams)} g × ${per.protein_g} g protein / 100 g = ${row.protein_g.toFixed(1)} g</span>
    Raw weight. <a href="https://fdc.nal.usda.gov/food-details/${u.fdc_id}/nutrients" target="_blank" rel="noopener">See the USDA entry</a>
  </div>`;
}

function mealHtml(day, meal, nut, mi) {
  const key = `${day}|${meal.slot}`;
  const rows = new Map((nut ? nut.ingredients : []).map((r) => [r.name, r]));
  const { floor, because } = timeFloor(meal);
  const timeNote = floor
    ? `Time checked: ${nice(because)} needs at least ${floor} min${RUN.spec.equipment.includes("pressure_cooker") && because.includes("brown_rice") ? " in a pressure cooker" : ""}, so ${meal.prep_minutes} min is realistic and fits your ${S.form.minutes}-minute limit.`
    : `Time checked: nothing slow-cooking here; ${meal.prep_minutes} min fits your ${S.form.minutes}-minute limit.`;
  const canSwap = S.stage === "review";
  const ingredients = meal.ingredients.map((i) => {
    const r = rows.get(i.name);
    const wkey = `${key}|${i.name}`;
    const prep = i.preparation && !/^(none|n\/a|-)$/i.test(i.preparation) ? `<em>, ${esc(i.preparation)}</em>` : "";
    return `<li><span class="grams">${Math.round(i.grams)} g</span><span>${esc(nice(i.name))}${prep}</span>
      ${r ? `<span class="ing-macros">${kcal(r.calories)} kcal · ${g(r.protein_g)}
        ${usda(i.name) ? `<button type="button" class="btn btn-link why-btn" data-why="${esc(wkey)}" data-k="why-${esc(wkey)}" aria-expanded="${S.why.has(wkey)}">Why?</button>` : ""}</span>` : ""}
      ${S.why.has(wkey) ? whyUsda(i.name, i.grams, r) : ""}</li>`;
  }).join("");
  const swapForm = S.swapping === key ? `
    <form class="swap" data-swap="${esc(key)}">
      <label class="field"><span>What would you rather have? <em>optional</em></span>
        <input data-k="swap-reason" name="reason" placeholder="something lighter, no potato" value="${key === "Monday|dinner" ? "something lighter, no potato" : ""}"></label>
      <div class="field"><span>Never use again this week</span><div class="chips">
        ${meal.ingredients.map((i) => `<label class="chip"><input type="checkbox" name="avoid" value="${esc(i.name)}" ${key === "Monday|dinner" && i.name === "potato" ? "checked" : ""}>${esc(nice(i.name))}</label>`).join("")}
      </div></div>
      ${S.swapNote ? `<p class="notice">${esc(S.swapNote)}</p>` : ""}
      <div class="row"><button class="btn btn-primary" type="submit">Swap this meal</button>
        <button class="btn btn-quiet" type="button" data-swap-cancel>Keep it</button></div>
    </form>` : "";
  return `<li class="meal${S.changedMeals.has(key) ? " changed" : ""}">
    <details data-meal="${esc(key)}" ${S.open.has(key) ? "open" : ""}>
      <summary data-k="sum-${esc(key)}"><span class="meal-slot">${SLOT[meal.slot]}</span><span class="meal-title">${esc(meal.title)}</span>
        <span class="meal-time">${meal.prep_minutes} min</span>
        ${nut ? `<span class="meal-macros">${kcal(nut.calories)} kcal · ${g(nut.protein_g)} protein</span>` : ""}</summary>
      <div class="meal-body">
        ${nut ? `<dl class="macro-strip" aria-label="Nutrition for ${esc(meal.title)}">
          <div><dt>Calories</dt><dd>${kcal(nut.calories)}</dd></div><div><dt>Protein</dt><dd>${g(nut.protein_g)}</dd></div>
          <div class="minor"><dt>Carbs</dt><dd>${g(nut.carbs_g)}</dd></div><div class="minor"><dt>Fat</dt><dd>${g(nut.fat_g)}</dd></div></dl>` : ""}
        <ul class="ingredients">${ingredients}</ul>
        ${meal.steps.length ? `<ol class="steps">${meal.steps.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>` : ""}
        ${meal.equipment_used.length ? `<p class="equipment">Uses ${esc(meal.equipment_used.map(nice).join(", "))}</p>` : ""}
        <p class="time-note">${esc(timeNote)}</p>
      </div>
    </details>
    ${canSwap && S.swapping !== key ? `<button type="button" class="btn btn-link swap-trigger" data-swap-open="${esc(key)}" data-k="swapbtn-${esc(key)}" aria-label="Swap ${esc(day)} ${SLOT[meal.slot].toLowerCase()}: ${esc(meal.title)}">Swap</button>` : ""}
    ${swapForm}
  </li>`;
}

function labelHtml(day) {
  const t = S.perDay[day.day];
  const meals = S.perMeal[day.day];
  return `<article class="label" aria-label="${day.day} plan">
    <h3 class="label-day">${day.day}</h3><div class="label-rule-thick"></div>
    <div class="label-row label-row-big"><span>Calories</span><strong>${kcal(t.calories)}</strong></div>
    <div class="label-target">target ${kcal(RUN.spec.macros.calories)} · ${signed(Math.round(t.calories_delta))}</div>
    <div class="label-rule-mid"></div>
    <div class="label-row"><span><b>Protein</b></span><strong>${g(t.protein_g)}</strong></div>
    <div class="label-target">target ${RUN.spec.macros.protein_g} g · ${signed(Math.round(t.protein_g_delta), " g")}</div>
    <div class="label-row label-row-info"><span>Carbs ${g(t.carbs_g)}</span><span>Fat ${g(t.fat_g)}</span></div>
    <div class="label-rule-thick"></div>
    <ul class="meals">${day.meals.map((m, i) => mealHtml(day.day, m, meals[i], i)).join("")}</ul>
  </article>`;
}

function checksHtml() {
  const gates = ["Calories within ±5% every day", "Protein within ±10 g", "No mushrooms or mayonnaise", "Halal",
    "Every meal ≤ 30 min", "Only your equipment", "Steps for every meal", "Variety across the week"];
  return `<section class="panel checks" aria-labelledby="checks-h">
    <h3 id="checks-h">How this plan was checked</h3>
    <p class="fine">Passed every check on the first try, so no repair rounds were needed. When a day fails, its repair round and what changed would be listed here.</p>
    <ul>${gates.map((x) => `<li>${x}</li>`).join("")}</ul>
  </section>`;
}

function gradualHtml() {
  const ex = RUN.gradual_example;
  if (S.gradual === "dismissed") return "";
  if (S.gradual === "accepted") {
    return `<section class="panel gradual" aria-live="polite"><h3>This week's small change is in</h3>
      <p>Monday lunch now uses brown rice. One change a week; the next suggestion comes with next week's plan.</p></section>`;
  }
  const d = (k) => ex.after[k] - ex.before[k];
  return `<section class="panel gradual" aria-labelledby="gradual-h">
    <h3 id="gradual-h">One small change this week</h3>
    <p>Brown rice instead of white in <b>${esc(ex.day)} lunch</b> (${esc(ex.meal)}). Same meal, same portion.</p>
    <div class="impact"><span>Calories ${signed(d("calories"))}</span><span>Protein ${signed(d("protein_g"), " g")}</span>
      <span>Carbs ${signed(d("carbs_g"), " g")}</span><span>Fat ${signed(d("fat_g"), " g")}</span></div>
    <p class="fine">Computed with MealCart's own checker. The main benefit of whole grains is fiber, which MealCart doesn't track yet. Brown rice takes 20 min in your pressure cooker, within your limit.</p>
    <div class="row"><button type="button" class="btn btn-primary" data-gradual="yes" data-k="gradual-yes">Try it this week</button>
      <button type="button" class="btn btn-quiet" data-gradual="no">Not this week</button></div>
  </section>`;
}

function groceryHtml() {
  const editable = S.stage === "review";
  return `<section aria-labelledby="gl-h">
    <div class="section-head"><h2 id="gl-h">Grocery list</h2>
      <p>${editable ? "Untick anything you already have." : "What MealCart shopped for."} Pantry items (salt, turmeric, rice, oil) are never bought.</p></div>
    <ul class="grocery-items">${items().map((i) => {
      const off = S.unticked.has(i.name);
      const loose = /×/.test(i.purchase_qty);
      const name = `<span class="grocery-name">${esc(nice(i.name))}</span>`;
      return `<li class="${off ? "is-removed" : ""}">
        ${editable ? `<label><input type="checkbox" data-untick="${esc(i.name)}" data-k="untick-${esc(i.name)}" ${off ? "" : "checked"}>${name}</label>` : name}
        <span class="grocery-qty mono">${esc(i.purchase_qty)}${loose ? `<span class="badge" title="Sold by count; weight estimated">est. weight</span>` : ""}</span>
        ${i.substitutes.length ? `<span class="grocery-subs">or ${esc(i.substitutes.map(nice).join(", "))}</span>` : ""}
      </li>`;
    }).join("")}</ul>
    <p class="fine" style="margin-top:8px">"est. weight" marks produce sold by count, where the weight is an estimate.</p>
  </section>`;
}

function reviewHtml() {
  const sp = RUN.spec;
  return `
    <section class="hero hero-run">
      <h1>${kcal(sp.macros.calories)} kcal · ${sp.macros.protein_g} g protein a day, for ${sp.days} days, ${esc(sp.cuisines.join(", "))}</h1>
    </section>
    ${S.persona === "dieter" || S.gradual !== "offer" ? gradualHtml() : ""}
    <section class="plan" aria-labelledby="plan-heading">
      <div class="section-head"><h2 id="plan-heading">The week</h2>
        <p>Calories and protein for every meal add up to the day on its label (shown rounded, so a total can differ by a point or two). Open a meal for its carbs, fat and per-ingredient numbers.${S.stage === "review" ? " Don't like a meal? Swap it before you approve." : ""}</p></div>
      <div class="labels${S.shownPlan ? " settled" : ""}">${S.plan.days.map(labelHtml).join("")}</div>
    </section>
    ${checksHtml()}
    ${S.persona !== "dieter" && S.gradual === "offer" ? gradualHtml() : ""}
    ${groceryHtml()}`;
}

function evidenceHtml() {
  return `<section class="panel evidence" aria-labelledby="ev-h">
    <h3 id="ev-h">Why Kroger</h3>
    <p class="fine">Stores ranked by how many of your hard-to-find items they stock. The activity feed lists the same counts as they come in.</p>
    <table><thead><tr><th>Store</th><th class="num">Hard-to-find items</th></tr></thead><tbody>
      <tr class="chosen"><td>Kroger ✓</td><td class="num">6 / 6</td></tr>
      <tr><td>Walmart</td><td class="num">5 / 6</td></tr>
      <tr><td>Aldi</td><td class="num">4 / 6</td></tr></tbody></table>
  </section>`;
}

function shoppingHtml() {
  const added = S.feed.filter((l) => l.message.startsWith("Added")).length;
  return `
    <section class="hero hero-run"><h1>Filling your Instacart cart…</h1>
      <p>Chrome runs hidden. MealCart searches, picks each product, and adds it. It never opens checkout.</p></section>
    ${S.feed.some((l) => l.message.startsWith("Kroger stocks")) ? evidenceHtml() : ""}
    <section aria-labelledby="prog-h"><div class="section-head"><h2 id="prog-h">Added so far</h2>
      <p class="mono">${added} of ${RUN.cart.lines.length} products</p></div>
      <ul class="grocery-items">${RUN.cart.lines.slice(0, added).map((l) => `<li><span class="grocery-name">${esc(l.product_name)}</span><span class="grocery-qty mono">× ${l.packs}</span></li>`).join("")}</ul>
    </section>`;
}

function whyProduct(l, cov) {
  const have = l.pack_grams * l.packs;
  const fewer = l.packs > 1 ? `${l.packs - 1} pack${l.packs > 2 ? "s" : ""} would be ${g(l.pack_grams * (l.packs - 1))}, short of what the week needs.` : "One pack covers it.";
  return `<div class="why-panel">Needed <b>${g(cov.grams_needed)}</b> for the week. ${esc(l.pack_size)} × ${l.packs} = ${g(have)}. ${fewer}
    <span class="calc">${usd(l.unit_price_usd)} each · ${usd(l.line_total_usd)}</span>
    </div>`;
}

function cartHtml() {
  const c = S.attention ? null : RUN.cart;
  if (S.attention) {
    const ex = RUN.needs_attention_example;
    return `<section class="hero hero-run"><h1>Your cart needs a look</h1>
        <p>At ${esc(ex.store)} · ${usd(ex.subtotal_usd)}. One store was missing some items.</p></section>
      <div class="callout"><b>${ex.missing.length} items weren't found.</b> Everything else is in the cart. Add these in Instacart, or start a new plan.</div>
      <table class="receipt"><thead><tr><th>For</th><th class="num">Need</th><th class="num">In cart</th></tr></thead><tbody>
        ${ex.missing.map((m) => `<tr class="is-missing"><td><span class="tick">✗</span>${esc(nice(m.item))}</td><td class="num mono">${g(m.grams_needed)}</td><td class="num mono">0 g</td></tr>`).join("")}
      </tbody></table>
      <ul class="notes">${ex.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      ${handoffHtml()}`;
  }
  const b = budget();
  const lines = c.coverage.map((cov) => {
    const l = c.lines.find((x) => x.grocery_item === cov.item);
    const left = cov.grams_in_cart - cov.grams_needed;
    const pct = cov.grams_in_cart ? left / cov.grams_in_cart : 0;
    const wkey = `prod|${cov.item}`;
    return `<tr><td><span class="tick">✓</span>${esc(nice(cov.item))}</td>
      <td>${esc(l.product_name)} <span class="muted">(${esc(l.pack_size)}) × ${l.packs}</span>
        <button type="button" class="btn btn-link why-btn" data-why="${esc(wkey)}" data-k="why-${esc(wkey)}" aria-expanded="${S.why.has(wkey)}">Why this product?</button>
        ${S.why.has(wkey) ? whyProduct(l, cov) : ""}</td>
      <td class="num mono">${g(cov.grams_needed)} / ${g(cov.grams_in_cart)}</td>
      <td class="num left-cell"><span class="left${pct > 0.6 ? " lots" : ""}">${g(left)} left (${Math.round(pct * 100)}%)</span></td>
      <td class="num mono">${usd(l.line_total_usd)}</td></tr>`;
  }).join("");
  const changes = S.swapped || S.gradual === "accepted" || S.unticked.size;
  return `
    <section class="hero hero-run"><h1>Your cart is ready</h1>
      <p>At ${esc(c.store)} · ${usd(c.subtotal_usd)}${b ? ` · ${c.subtotal_usd <= b ? `within your ${usd(b)} budget` : `<span class="over">${usd(c.subtotal_usd - b)} over budget</span>`}` : ""}</p>
      <p style="margin-top:10px"><span class="stamp">✓ Verified against your cart</span></p></section>
    ${S.zipMismatch ? `<div class="callout">Instacart is set to deliver to ${RUN.spec.zip_code}, not your ZIP ${esc(S.form.zip)}. These stores and prices are for ${RUN.spec.zip_code}.</div>` : ""}
    ${changes ? `<p class="notice fixed-note">In this prototype the cart is fixed, so changes you made to the plan aren't reflected here.</p>` : ""}
    <section aria-labelledby="cart-h">
      <div class="section-head"><h2 id="cart-h">Every item, checked</h2>
        <p>MealCart read the cart back from Instacart and compared it with your list. "Left over" is what the week won't use.</p></div>
      <table class="receipt">
        <thead><tr><th>For</th><th>In your cart</th><th class="num">Need / have</th><th class="num">Left over</th><th class="num">Price</th></tr></thead>
        <tbody>${lines}</tbody>
        <tfoot><tr><th colspan="4">Subtotal before fees</th><td class="num mono">${usd(c.subtotal_usd)}</td></tr></tfoot>
      </table>
      <p class="fine usage">AI used: ${RUN.llm_calls.length} calls · free tier · ${usageModels()} · ${RUN.llm_calls.reduce((s, x) => s + x.input_tokens + x.output_tokens, 0).toLocaleString("en-US")} tokens</p>
    </section>
    ${handoffHtml()}`;
}

function usageModels() {
  const counts = {};
  RUN.llm_calls.forEach((c) => { const m = c.model.replace("openai/", ""); counts[m] = (counts[m] || 0) + 1; });
  return Object.entries(counts).map(([m, n]) => `${m} ×${n}`).join(", ");
}

function handoffHtml() {
  return `<div class="checkout"><p><b>You check out yourself.</b> MealCart never opens checkout or touches payment; it stops here.</p>
    <button type="button" class="btn btn-primary" data-handoff data-k="handoff">Open Instacart</button>
    <button type="button" class="btn btn-quiet" data-restart>Start a new plan</button></div>`;
}

function failedHtml() {
  return `<section class="failure" role="alert"><h2>This plan stopped</h2>
    <p>Every AI model is out of free quota or busy. Nothing was bought. Gemini's free quota resets daily; try again later.</p>
    <ul>${S.feed.filter((l) => l.node === "model").map((l) => `<li>${esc(l.message)}</li>`).join("")}</ul>
    <button type="button" class="btn btn-quiet" data-restart>Start a new plan</button></section>`;
}

// ---------- Rendering: rail ----------

function questionHtml() {
  const q = S.question;
  if (!q) return "";
  let title, body;
  if (q.kind === "plan_approval") {
    const n = keptItems().length;
    const est = estimate();
    const b = budget();
    title = "Approve the grocery list";
    body = `<p>${n} item${n === 1 ? "" : "s"}${S.unticked.size ? ` (${S.unticked.size} unticked)` : ""} · est. <span class="mono">${usd(est)}</span>
        <span class="badge">from your last cart's prices</span>${b ? ` · ${est <= b ? `within your ${usd(b)} budget` : `<span class="over">${usd(est - b)} over budget</span>`}` : ""}</p>
      <p class="fine">Nothing touches Instacart until you approve. This pause is saved, so it still works after a restart.</p>
      <div class="row"><button type="button" class="btn btn-primary" data-approve data-k="approve">Fill my cart</button>
        <button type="button" class="btn btn-quiet" data-cancel>Cancel this plan</button></div>`;
  } else if (q.kind === "email_code") {
    title = `Enter your Instacart code`;
    body = `<p>Instacart sent a code to your email. What is it?</p>
      <form data-answer="code"><label class="field"><span>Code</span><input data-k="code" inputmode="numeric" autocomplete="one-time-code" placeholder="any 6 digits"></label>
      <button class="btn btn-primary" type="submit">Send code</button>
      <p class="fine">Typed straight into Instacart in the Chrome window. MealCart doesn't save it.</p></form>`;
  } else if (q.kind === "cart_clear_approval") {
    title = `Your cart already has items`;
    body = `<p>Your Kroger cart already has 2 items: Kroger® 2% Reduced Fat Milk, Simple Truth Organic® Baby Spinach. Clear it first?</p>
      <div class="row"><button type="button" class="btn btn-primary" data-answer-btn="clear" data-k="clear">Empty it first</button>
        <button type="button" class="btn btn-quiet" data-answer-btn="clear">Keep those items</button></div>`;
  } else if (q.kind === "substitution_approval") {
    title = `Approve a substitute`;
    body = `<p>No store has rolled oats. Use Kroger® Quick Oats (quick_oats) instead? It breaks the plan's checks: Tuesday calories 1,812 (target 1,850 ±5%).</p>
      <div class="row"><button type="button" class="btn btn-primary" data-answer-btn="sub" data-k="sub">Use substitute</button>
        <button type="button" class="btn btn-quiet" data-answer-btn="sub">Skip it</button></div>`;
  }
  return `<section class="question" id="question" aria-live="assertive" aria-labelledby="q-h">
    <p class="eyebrow">Your answer is needed</p><h2 id="q-h">${title}</h2>${body}</section>`;
}

function guideHtml() {
  const p = PERSONAS[S.persona];
  if (!p) {
    return `<section class="how" aria-labelledby="how-h"><h2 id="how-h" class="eyebrow">How a run goes</h2><ol>
      <li><b>Set targets.</b> Calories, protein, and your rules.</li>
      <li><b>Review the week.</b> Swap meals, untick what you have.</li>
      <li><b>Approve.</b> Nothing is bought before this.</li>
      <li><b>Check the cart.</b> Then check out in Instacart yourself.</li></ol>
      <p class="fine" style="margin-top:8px">Use the bar above to jump to a journey or play as a persona.</p></section>`;
  }
  const done = p.tasks.every(([k]) => S.met.has(k));
  return `<section class="guide" aria-labelledby="guide-h"><p class="eyebrow">Playing as</p>
    <h2 id="guide-h">${p.name}</h2><p class="model">${p.model}</p>
    <ol>${p.tasks.map(([k, t]) => `<li class="${S.met.has(k) ? "met" : ""}"><span>${esc(t)}${S.met.has(k) ? '<span class="sr-only"> (done)</span>' : ""}</span></li>`).join("")}</ol>
    ${done ? `<p class="success"><b>Success:</b> ${esc(p.success)}</p>` : ""}</section>`;
}

function feedHtml() {
  if (!S.feed.length && !S.working) return "";
  return `<section class="feed" aria-labelledby="feed-h"><h2 id="feed-h" class="eyebrow">Activity</h2><ol aria-live="polite">
    ${S.working ? '<li class="feed-working"><span class="feed-step">Now</span><span>Working…</span></li>' : ""}
    ${[...S.feed].reverse().map((l) => `<li><span class="feed-step">${STEP[l.node] || l.node}</span><span>${esc(l.message)}</span></li>`).join("")}
  </ol></section>`;
}

// ---------- Render ----------

function render() {
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  stagesHtml();
  const content = { form: formHtml, planning: planningHtml, review: reviewHtml, shopping: shoppingHtml, cart: cartHtml, failed: failedHtml }[S.stage]();
  $("#content").innerHTML = content;
  $("#rail").innerHTML = questionHtml() + guideHtml() + feedHtml();
  if (S.stage === "review") S.shownPlan = true;  // labels animate in once, not on every re-render
  if (focusKey) {
    const el = document.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
    if (el) el.focus();
  }
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// ---------- Actions ----------

function submitSpec() {
  const f = S.form;
  if (f.mode === "words") {
    const zip = (f.words.match(/\b\d{5}\b/) || [])[0];
    if (!zip) { S.formError = "Include your 5-digit ZIP code so MealCart can check Instacart delivers there."; render(); return; }
    f.zip = zip;
  } else if (!/^\d{5}$/.test(f.zip)) {
    S.formError = "Enter your 5-digit ZIP code. MealCart checks it against Instacart's delivery address.";
    render();
    const z = document.querySelector('[data-f="zip"]');
    if (z) z.focus();
    return;
  }
  S.formError = "";
  startPlanning();
  render();
  window.scrollTo(0, 0);
}

function doSwap(key, form) {
  const [day, slot] = key.split("|");
  if (key !== "Monday|dinner") {
    S.swapNote = "In this prototype, only Monday dinner can be swapped. Try that one.";
    render();
    return;
  }
  const ex = RUN.swap_example;
  const reason = form.reason.value.trim();
  S.swapping = null;
  S.swapNote = "";
  S.question = null;
  script([
    ["swap", `Replacing ${day} ${slot}: ${ex.old_title}…`],
    ["swap", `New ${slot}: ${ex.day_plan.meals.find((m) => m.slot === slot).title}`],
    ["solve", "Portions sized to hit calories and protein"],
    ["validate", "Plan passed every check"],
    ["consolidate", "Grocery list ready: 14 items"],
  ], 500, () => {
    const i = S.plan.days.findIndex((d) => d.day === day);
    S.plan.days[i] = clone(ex.day_plan);
    S.perDay[day] = clone(ex.per_day);
    S.perMeal[day] = clone(ex.per_meal);
    S.changedMeals.add(key);
    S.open.add(key);
    S.swapped = true;
    meet("swap");
    S.question = { kind: "plan_approval" };
    toast(`Swapped. Monday is now ${kcal(ex.per_day.calories)} kcal and ${g(ex.per_day.protein_g)} protein${reason ? `; "${reason}" noted` : ""}.`);
  });
  render();
}

function acceptGradual() {
  const ex = RUN.gradual_example;
  const day = S.plan.days.find((d) => d.day === ex.day);
  const mi = day.meals.findIndex((m) => m.slot === ex.slot);
  const meal = day.meals[mi];
  const ing = meal.ingredients.find((i) => i.name === ex.from);
  ing.name = ex.to;
  meal.steps = meal.steps.map((st) => st.replace(/white rice/gi, "brown rice"));
  const nut = S.perMeal[ex.day][mi];
  const t = S.perDay[ex.day];
  for (const k of ["calories", "protein_g", "carbs_g", "fat_g"]) {
    const d = ex.after[k] - ex.before[k];
    nut[k] += d;
    t[k] += d;
  }
  t.calories_delta += ex.after.calories - ex.before.calories;
  t.protein_g_delta += ex.after.protein_g - ex.before.protein_g;
  const row = nut.ingredients.find((r) => r.name === ex.from);
  if (row) {
    const per = RUN.usda[ex.to].per_100g;
    Object.assign(row, { name: ex.to, calories: per.calories * ing.grams / 100, protein_g: per.protein_g * ing.grams / 100,
      carbs_g: per.carbs_g * ing.grams / 100, fat_g: per.fat_g * ing.grams / 100 });
  }
  const key = `${ex.day}|${ex.slot}`;
  S.changedMeals.add(key);
  S.open.add(key);
  S.gradual = "accepted";
  meet("gradual");
  say("validate", "Monday re-checked after your change: passed");
}

// ---------- Events ----------

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-mode]");
  if (!t) return;
  const d = t.dataset;
  if (d.journey) { jump(d.journey); return; }
  if (d.mode) { S.form.mode = d.mode; S.formError = ""; render(); return; }
  if (d.why) {
    S.why.has(d.why) ? S.why.delete(d.why) : S.why.add(d.why);
    if (d.why.startsWith("prod|")) meet("product"); else meet("usda");
    render();
    return;
  }
  if (d.swapOpen) { S.swapping = d.swapOpen; S.swapNote = ""; render(); const r = document.querySelector('[data-k="swap-reason"]'); if (r) r.focus(); return; }
  if ("swapCancel" in d) { const k = S.swapping; S.swapping = null; render(); const b = document.querySelector(`[data-k="swapbtn-${CSS.escape(k)}"]`); if (b) b.focus(); return; }
  if (d.gradual) {
    if (d.gradual === "yes") { acceptGradual(); toast("Brown rice is in for Monday lunch. Monday re-checked and still on target."); }
    else { S.gradual = "dismissed"; toast("No change this week."); }
    render();
    return;
  }
  if ("approve" in d) { startShopping(); render(); return; }
  if ("cancel" in d) { reset(); render(); toast("Plan cancelled. Nothing was bought."); return; }
  if (d.answerBtn) { continueShopping(d.answerBtn); render(); return; }
  if ("handoff" in d) { meet("cart"); toast("This opens Instacart in your browser. You review each store's cart and check out there."); return; }
  if ("restart" in d) { jump("J1"); return; }
  if (t.id === "theme") {
    const dark = !currentlyDark();
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    t.setAttribute("aria-pressed", String(dark));
    t.textContent = dark ? "Light" : "Dark";
  }
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === "spec") { submitSpec(); return; }
  if (f.dataset.swap) { doSwap(f.dataset.swap, f); return; }
  if (f.dataset.answer === "code") {
    const v = f.querySelector("input").value.trim();
    if (!v) return;
    continueShopping("code");
    render();
  }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.f) {
    if (el.dataset.f === "zip") el.value = el.value.replace(/\D/g, "").slice(0, 5);
    S.form[el.dataset.f] = el.value;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.chip) {
    const list = S.form[el.dataset.chip];
    const i = list.indexOf(el.value);
    if (el.checked && i < 0) list.push(el.value);
    if (!el.checked && i >= 0) list.splice(i, 1);
  }
  if (el.dataset.untick) {
    el.checked ? S.unticked.delete(el.dataset.untick) : S.unticked.add(el.dataset.untick);
    meet("untick");
    render();
  }
  if (el.id === "persona") {
    S.persona = el.value;
    S.met = new Set();
    if (S.persona) jump(PERSONAS[S.persona].start); else render();
  }
  if (el.id === "failure") {
    S.failure = el.value || null;
    if (el.value === "quota") { jump("J1"); S.form.zip = RUN.spec.zip_code; startPlanning(); render(); }
    else if (el.value === "attention") jump("J5");
    else if (el.value === "zip") jump("J4");
  }
});

// Remember which meals are open, so a re-render keeps them open.
document.addEventListener("toggle", (e) => {
  const key = e.target.dataset && e.target.dataset.meal;
  if (!key) return;
  if (e.target.open) { S.open.add(key); meet("open"); meet("time"); } else { S.open.delete(key); }
  if (S.persona) $("#rail").innerHTML = questionHtml() + guideHtml() + feedHtml();
}, true);

// ---------- Start ----------

function currentlyDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

try {
  const saved = localStorage.getItem("mealcart-proto-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch (_) { /* storage unavailable */ }
new MutationObserver(() => {
  try { localStorage.setItem("mealcart-proto-theme", document.documentElement.dataset.theme || ""); } catch (_) { /* ignore */ }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

reset();
const themeBtn = $("#theme");
themeBtn.setAttribute("aria-pressed", String(currentlyDark()));
themeBtn.textContent = currentlyDark() ? "Light" : "Dark";
render();
