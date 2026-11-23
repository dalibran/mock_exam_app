let questionBank = [];
let questionLookup = new Map();
let meta = null;
let state = null;
let timerHandle = null;

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "oms6250-mock-exam-state-v1";
const HISTORY_KEY = "oms6250-mock-exam-history-v1";

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function groupByModule(questions) {
  return questions.reduce((acc, q) => {
    (acc[q.module] ||= []).push(q);
    return acc;
  }, {});
}

function allocateCounts(total, groups, mode) {
  const entries = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  const availableTotal = entries.reduce((sum, [, qs]) => sum + qs.length, 0);
  if (!availableTotal) return {};
  if (total > availableTotal) total = availableTotal;

  if (mode === "balanced") {
    const base = Math.floor(total / entries.length);
    let remaining = total - base * entries.length;
    const counts = Object.fromEntries(entries.map(([module, qs]) => [module, Math.min(base, qs.length)]));
    let assigned = Object.values(counts).reduce((s, c) => s + c, 0);
    remaining = total - assigned;
    while (remaining > 0) {
      const candidates = shuffle(entries).filter(([module, qs]) => counts[module] < qs.length);
      if (!candidates.length) break;
      counts[candidates[0][0]]++;
      remaining--;
    }
    return counts;
  }

  const raw = entries.map(([module, qs]) => {
    const exact = total * qs.length / availableTotal;
    return { module, available: qs.length, count: Math.floor(exact), frac: exact - Math.floor(exact) };
  });

  // Avoid zero-question modules when possible.
  for (const r of raw) {
    if (r.count === 0 && r.available > 0 && total >= raw.length) r.count = 1;
  }
  let assigned = raw.reduce((s, r) => s + r.count, 0);
  raw.sort((a, b) => b.frac - a.frac || a.module.localeCompare(b.module));
  while (assigned < total) {
    for (const r of raw) {
      if (assigned >= total) break;
      if (r.count < r.available) { r.count++; assigned++; }
    }
  }
  while (assigned > total) {
    for (const r of raw.slice().reverse()) {
      if (assigned <= total) break;
      if (r.count > 0) { r.count--; assigned--; }
    }
  }
  return Object.fromEntries(raw.map(r => [r.module, r.count]));
}

function normalizeCorrectAnswer(q) {
  return String(q.correctAnswer)
    .split(/[,/&]|\band\b/i)
    .map(x => x.trim())
    .filter(Boolean);
}

function hydrateQuestionForExam(q, shuffleChoices) {
  const choices = q.displayChoices || Object.entries(q.choices || {}).map(([key, text]) => ({ key, text }));
  return {
    ...q,
    displayChoices: shuffleChoices ? shuffle(choices) : choices,
    correctAnswers: q.correctAnswers || normalizeCorrectAnswer(q)
  };
}

function makeExamQuestions(pool, count, distribution, shuffleChoices) {
  const groups = groupByModule(pool);
  const counts = allocateCounts(count, groups, distribution);
  let selected = [];
  for (const [module, moduleCount] of Object.entries(counts)) {
    selected = selected.concat(shuffle(groups[module]).slice(0, moduleCount));
  }
  selected = shuffle(selected);
  return selected.map(q => hydrateQuestionForExam(q, shuffleChoices));
}

function populateQuestionCountOptions() {
  const select = $("questionCount");
  if (!select || !meta || select.dataset.populated === "1") return;

  const maxSelectable = Math.min(60, meta.questionCount);
  const defaultValue = maxSelectable >= 40 ? "40" : String(Math.max(10, maxSelectable));
  const options = [];
  for (let count = 10; count <= maxSelectable; count += 10) {
    options.push({ value: String(count), label: String(count) });
  }
  options.push({ value: "random", label: "Random 40-60" });

  select.innerHTML = options.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join("");
  select.value = defaultValue;
  select.dataset.populated = "1";
}

function saveState() {
  if (state && state.mode === "exam") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function loadSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || saved.mode !== "exam" || !Array.isArray(saved.questions)) return null;
    saved.questions = saved.questions.map(q => hydrateQuestionForExam(q, false));
    return saved;
  } catch { return null; }
}

function clearSavedState() {
  localStorage.removeItem(STORAGE_KEY);
}

function loadHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function clearHistory() {
  if (!confirm("Clear all saved exam attempt history? This cannot be undone.")) return;
  localStorage.removeItem(HISTORY_KEY);
  renderSetupAvailability();
  renderHistory();
}

function formatPercent(correct, total) {
  if (!total) return "0%";
  const pct = Math.round((correct / total) * 1000) / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct}%`;
}

function formatScore(points, total) {
  return `${Number(points.toFixed(2))}/${total} (${formatPercent(points, total)})`;
}

function formatAttemptDate(ts) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function moduleNumberFromName(moduleName) {
  const match = String(moduleName).match(/Module\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function questionIdFromModuleAndRef(moduleName, ref) {
  const moduleNum = moduleNumberFromName(moduleName);
  const qMatch = String(ref).match(/Q\s*(\d+)/i);
  if (!moduleNum || !qMatch) return null;
  return `m${String(moduleNum).padStart(2, "0")}-q${String(Number(qMatch[1])).padStart(3, "0")}`;
}

function questionRef(qOrResult) {
  const n = qOrResult?.number;
  return n ? `Q${n}` : qOrResult?.id || "Unknown question";
}

function sortQuestionIds(ids) {
  return [...ids].sort((a, b) => {
    const qa = questionLookup.get(a);
    const qb = questionLookup.get(b);
    const ma = qa?.moduleNumber || moduleNumberFromName(qa?.module) || 999;
    const mb = qb?.moduleNumber || moduleNumberFromName(qb?.module) || 999;
    if (ma !== mb) return ma - mb;
    return (qa?.number || 9999) - (qb?.number || 9999);
  });
}

function getSeenQuestionIds(history = loadHistory()) {
  const seen = new Set();
  for (const attempt of history) {
    if (Array.isArray(attempt.questionResults)) {
      for (const result of attempt.questionResults) {
        if (result.id) seen.add(result.id);
      }
    }
    for (const [module, refs] of Object.entries(attempt.questionRefsByModule || {})) {
      for (const ref of refs || []) {
        const id = questionIdFromModuleAndRef(module, ref);
        if (id) seen.add(id);
      }
    }
  }
  return seen;
}

function getMissedQuestionIds(history = loadHistory()) {
  const missed = new Set();
  for (const attempt of history) {
    if (!Array.isArray(attempt.questionResults)) continue;
    for (const result of attempt.questionResults) {
      if (result.id && result.isCorrect === false) missed.add(result.id);
    }
  }
  return missed;
}

function getQuestionPoolForSourceMode(sourceMode) {
  const history = loadHistory();
  if (sourceMode === "unseen") {
    const seen = getSeenQuestionIds(history);
    return questionBank.filter(q => !seen.has(q.id));
  }
  if (sourceMode === "missed") {
    const missed = getMissedQuestionIds(history);
    return questionBank.filter(q => missed.has(q.id));
  }
  return questionBank.slice();
}

function buildDetailedQuestionStats(history = loadHistory()) {
  const stats = {};
  for (const attempt of history) {
    if (!Array.isArray(attempt.questionResults)) continue;
    for (const result of attempt.questionResults) {
      if (!result.id) continue;
      stats[result.id] ||= { seen: 0, correct: 0, missed: 0, lastCorrect: null };
      stats[result.id].seen++;
      if (result.isCorrect) stats[result.id].correct++;
      else stats[result.id].missed++;
      stats[result.id].lastCorrect = !!result.isCorrect;
    }
  }
  return stats;
}

function buildMissedByModuleFromIds(ids, stats = {}) {
  const byModule = {};
  for (const id of sortQuestionIds(ids)) {
    const q = questionLookup.get(id);
    if (!q) continue;
    byModule[q.module] ||= [];
    byModule[q.module].push({ q, stats: stats[id] || null });
  }
  return byModule;
}

function promptPreview(q, max = 130) {
  const text = String(q?.prompt || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderMissedModules(byModule, emptyText, legacyText = "") {
  const entries = Object.entries(byModule).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    return `<p class="small muted">${escapeHtml(emptyText)}</p>${legacyText ? `<p class="small muted">${escapeHtml(legacyText)}</p>` : ""}`;
  }
  return `<div class="missed-modules">
    ${entries.map(([module, items]) => `<details class="missed-module">
      <summary>${escapeHtml(module)} — ${items.length} missed question${items.length === 1 ? "" : "s"}</summary>
      <ul>
        ${items.map(({ q, stats }) => {
          const statText = stats ? ` <span class="small muted">(${stats.correct}/${stats.seen} fully correct; missed ${stats.missed}x${stats.lastCorrect === true ? "; last correct" : stats.lastCorrect === false ? "; last missed" : ""})</span>` : "";
          return `<li><strong>${escapeHtml(questionRef(q))}</strong>${statText}<br><span class="small muted">${escapeHtml(promptPreview(q))}</span></li>`;
        }).join("")}
      </ul>
    </details>`).join("")}
  </div>${legacyText ? `<p class="small muted">${escapeHtml(legacyText)}</p>` : ""}`;
}

function renderSetupAvailability() {
  const el = $("sourcePoolSummary");
  if (!el || !meta) return;
  const history = loadHistory();
  const seen = getSeenQuestionIds(history);
  const missed = getMissedQuestionIds(history);
  const sourceMode = $("questionSource")?.value || "all";
  const pool = getQuestionPoolForSourceMode(sourceMode);
  const legacyAttempts = history.filter(a => !Array.isArray(a.questionResults)).length;

  let sourceText = "Drawing from all questions.";
  if (sourceMode === "unseen") sourceText = "Drawing only from questions not seen in previous attempts.";
  if (sourceMode === "missed") sourceText = "Drawing only from questions missed in previous v4+ attempts.";

  el.innerHTML = `${escapeHtml(sourceText)} <strong>${pool.length}</strong> available. ` +
    `<span class="muted">Seen: ${seen.size}/${meta.questionCount}; unseen: ${Math.max(0, meta.questionCount - seen.size)}; detailed missed pool: ${missed.size}.</span>` +
    (legacyAttempts ? `<br><span class="muted">Note: ${legacyAttempts} older attempt${legacyAttempts === 1 ? "" : "s"} preserved; they count toward seen coverage, but do not contain exact missed-question IDs.</span>` : "");
}

function renderHistory() {
  const history = loadHistory();
  const list = $("attemptHistory");
  const summary = $("historySummary");
  const clearButton = $("clearHistory");
  if (!list || !summary || !clearButton) return;

  clearButton.hidden = history.length === 0;
  if (!history.length) {
    summary.innerHTML = "";
    list.innerHTML = `<p class="small muted">No saved exam attempts yet.</p>`;
    return;
  }

  const aggregate = {};
  const seenIds = getSeenQuestionIds(history);
  const missedIds = getMissedQuestionIds(history);
  const detailedStats = buildDetailedQuestionStats(history);
  const legacyAttempts = history.filter(a => !Array.isArray(a.questionResults)).length;

  for (const attempt of history) {
    for (const [module, stats] of Object.entries(attempt.moduleStats || {})) {
      aggregate[module] ||= { pointsEarned: 0, total: 0, covered: new Set() };
      aggregate[module].pointsEarned += stats.pointsEarned ?? stats.correct ?? 0;
      aggregate[module].total += stats.total || 0;
    }
    for (const [module, refs] of Object.entries(attempt.questionRefsByModule || {})) {
      aggregate[module] ||= { pointsEarned: 0, total: 0, covered: new Set() };
      for (const ref of refs || []) aggregate[module].covered.add(ref);
    }
    if (Array.isArray(attempt.questionResults)) {
      for (const result of attempt.questionResults) {
        aggregate[result.module] ||= { pointsEarned: 0, total: 0, covered: new Set() };
        aggregate[result.module].covered.add(questionRef(result));
      }
    }
  }

  const missedByModule = buildMissedByModuleFromIds(missedIds, detailedStats);
  const legacyText = legacyAttempts ? `${legacyAttempts} older attempt${legacyAttempts === 1 ? " was" : "s were"} preserved, but exact missed-question IDs were not stored until v4.` : "";

  summary.innerHTML = `
    <h3>Cumulative module coverage</h3>
    <div class="module-results">
      ${Object.entries(aggregate).sort(([a], [b]) => a.localeCompare(b)).map(([module, stats]) => {
        const moduleTotal = meta.moduleCounts?.[module] || 0;
        const uniqueSeen = stats.covered.size || [...seenIds].filter(id => questionLookup.get(id)?.module === module).length;
        return `<div>
          <strong>${escapeHtml(module)}</strong><br>
          ${formatScore(stats.pointsEarned, stats.total)}<br>
          <span class="small muted">${uniqueSeen}/${moduleTotal} unique source questions seen</span>
        </div>`;
      }).join("")}
    </div>
    <details class="history-detail" open>
      <summary>Cumulative missed questions by module</summary>
      ${renderMissedModules(missedByModule, "No detailed missed-question records yet.", legacyText)}
    </details>
  `;

  const displayRows = history.map((attempt, i) => ({ attempt, attemptNumber: i + 1 })).reverse();
  list.innerHTML = displayRows.map(({ attempt, attemptNumber }) => {
    const moduleLine = Object.entries(attempt.moduleStats || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, stats]) => `${escapeHtml(module)} - ${formatScore(stats.pointsEarned ?? stats.correct, stats.total)}`)
      .join("; ");
    const coverageDetails = Object.entries(attempt.questionRefsByModule || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, refs]) => `<p><strong>${escapeHtml(module)}:</strong> ${escapeHtml((refs || []).join(", "))}</p>`)
      .join("");

    let missedDetails = `<p class="small muted">Exact missed-question detail was not stored for this older attempt. New attempts taken in v4 will show this.</p>`;
    if (Array.isArray(attempt.questionResults)) {
      const missedAttemptIds = attempt.questionResults.filter(r => r.isCorrect === false).map(r => r.id).filter(Boolean);
      const byModule = buildMissedByModuleFromIds(new Set(missedAttemptIds));
      missedDetails = renderMissedModules(byModule, "No missed questions in this attempt.");
    }

    return `<article class="attempt-card">
      <h4>Exam Attempt #${attemptNumber}</h4>
      <p><strong>${formatAttemptDate(attempt.submittedAt)}</strong> · ${formatScore(attempt.pointsEarned ?? attempt.correctCount, attempt.questionCount)} · ${formatDuration(attempt.elapsedMs || 0)}</p>
      <p>${moduleLine}</p>
      <details>
        <summary>Missed questions</summary>
        <div class="coverage-details">${missedDetails}</div>
      </details>
      <details>
        <summary>Source questions covered</summary>
        <div class="coverage-details">${coverageDetails}</div>
      </details>
    </article>`;
  }).join("");
}

function clearExamUi() {
  const ids = [
    "progressText", "answeredText", "questionNav", "questionModule", "questionType",
    "flagStatus", "questionPrompt", "questionImages", "answerChoices", "reviewList",
    "scoreSummary", "moduleResults"
  ];
  for (const id of ids) {
    const el = $(id);
    if (el) el.innerHTML = "";
    if (el) el.textContent = "";
  }
}

function renderSetup() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  window.onbeforeunload = null;
  clearExamUi();
  populateQuestionCountOptions();
  $("setup").hidden = false;
  $("exam").hidden = true;
  $("results").hidden = true;
  $("timer").hidden = true;
  $("timer").classList.remove("warning");
  const counts = meta.moduleCounts;
  const moduleCount = Object.keys(counts).length;
  $("bankSummary").textContent = `${meta.questionCount} questions loaded from ${moduleCount} ${moduleCount === 1 ? "module" : "modules"}.`;
  $("moduleBreakdown").innerHTML = Object.entries(counts)
    .map(([module, count]) => `<div><strong>${module}</strong><br>${count} questions</div>`).join("");
  const saved = loadSavedState();
  $("resumeExam").hidden = !saved;
  $("clearSaved").hidden = !saved;
  renderSetupAvailability();
  renderHistory();
}

function getRequestedQuestionCount() {
  const countValue = $("questionCount").value;
  const count = countValue === "random" ? 40 + Math.floor(Math.random() * 21) : Number(countValue);
  return { countValue, count };
}

function startExam() {
  const { countValue, count } = getRequestedQuestionCount();
  const minutes = Number($("timerMinutes").value);
  const sourceMode = $("questionSource")?.value || "all";
  const pool = getQuestionPoolForSourceMode(sourceMode);

  if (!pool.length) {
    if (sourceMode === "missed") {
      alert("There are no detailed missed questions yet. This feature uses exact missed-question records from v4+ attempts.");
    } else if (sourceMode === "unseen") {
      alert("No unseen questions are available based on saved attempt history.");
    } else {
      alert("No questions are available.");
    }
    return;
  }

  const effectiveCount = Math.min(count, pool.length);
  if (effectiveCount < count) {
    const ok = confirm(`Only ${effectiveCount} question${effectiveCount === 1 ? " is" : "s are"} available for this source. Start a ${effectiveCount}-question exam?`);
    if (!ok) return;
  }

  const questions = makeExamQuestions(pool, effectiveCount, $("distribution").value, $("shuffleChoices").checked);
  state = {
    mode: "exam",
    startedAt: Date.now(),
    durationMs: minutes > 0 ? minutes * 60 * 1000 : 0,
    currentIndex: 0,
    questions,
    answers: {},
    flagged: {},
    submittedAt: null,
    distribution: $("distribution").value,
    questionCountSetting: countValue,
    sourceMode
  };
  saveState();
  renderExam();
}

function resumeExam() {
  state = loadSavedState();
  if (!state) return renderSetup();
  renderExam();
}

function renderExam() {
  $("setup").hidden = true;
  $("exam").hidden = false;
  $("results").hidden = true;
  $("timer").hidden = state.durationMs === 0;
  renderTimer();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(renderTimer, 500);
  renderQuestionNav();
  renderQuestion();
  window.onbeforeunload = () => state && state.mode === "exam" ? "An exam is in progress." : undefined;
}

function renderTimer() {
  if (!state || state.durationMs === 0) return;
  const elapsed = Date.now() - state.startedAt;
  const remaining = Math.max(0, state.durationMs - elapsed);
  const totalSeconds = Math.ceil(remaining / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  $("timer").textContent = `${h}:${m}:${s}`;
  $("timer").classList.toggle("warning", remaining <= 10 * 60 * 1000);
  if (remaining <= 0 && state.mode === "exam") {
    submitExam(true);
  }
}

function renderQuestionNav() {
  const answeredCount = Object.values(state.answers).filter(a => Array.isArray(a) && a.length).length;
  $("progressText").textContent = `Question ${state.currentIndex + 1} of ${state.questions.length}`;
  $("answeredText").textContent = `${answeredCount} answered`;
  $("questionNav").innerHTML = state.questions.map((q, i) => {
    const answered = state.answers[q.id]?.length;
    const flagged = state.flagged[q.id];
    const cls = [i === state.currentIndex ? "current" : "", answered ? "answered" : "", flagged ? "flagged" : ""].join(" ");
    return `<button class="${cls}" data-index="${i}" title="${q.module} Q${q.number}">${i + 1}</button>`;
  }).join("");
  document.querySelectorAll("#questionNav button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentIndex = Number(btn.dataset.index);
      saveState();
      renderQuestionNav();
      renderQuestion();
    });
  });
}

function renderQuestion() {
  const q = state.questions[state.currentIndex];
  $("questionModule").textContent = `${q.module} / Source Q${q.number}`;
  $("questionType").textContent = q.type === "true_false" ? "True / False" : q.type === "select_all" ? "Select all that apply" : "Multiple choice";
  $("flagStatus").textContent = state.flagged[q.id] ? "Flagged" : "";
  $("questionPrompt").textContent = q.prompt;
  $("questionImages").innerHTML = (q.images || []).map(src => `
    <figure>
      <img src="${src}" alt="Question figure">
      ${q.figureCaption ? `<figcaption>${escapeHtml(q.figureCaption)}</figcaption>` : ""}
    </figure>`).join("");
  const inputType = q.type === "select_all" ? "checkbox" : "radio";
  const selected = state.answers[q.id] || [];
  $("answerChoices").innerHTML = q.displayChoices.map((choice, idx) => {
    const displayLabel = optionLabel(idx);
    const checked = selected.includes(choice.key) ? "checked" : "";
    return `<label class="choice">
      <input type="${inputType}" name="answer" value="${escapeHtml(choice.key)}" ${checked}>
      <span><strong>${displayLabel}.</strong> ${escapeHtml(choice.text)}</span>
    </label>`;
  }).join("");
  document.querySelectorAll('#answerChoices input').forEach(input => {
    input.addEventListener('change', () => captureAnswer(q));
  });
  $("prevQuestion").disabled = state.currentIndex === 0;
  $("nextQuestion").disabled = state.currentIndex === state.questions.length - 1;
  $("flagQuestion").textContent = state.flagged[q.id] ? "Unflag" : "Flag";
}

function captureAnswer(q) {
  const checked = [...document.querySelectorAll('#answerChoices input:checked')].map(i => i.value);
  state.answers[q.id] = checked;
  saveState();
  renderQuestionNav();
}

function optionLabel(idx) {
  return String.fromCharCode("A".charCodeAt(0) + idx);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}

function answersEqual(a, b) {
  const x = (a || []).slice().sort().join("|");
  const y = (b || []).slice().sort().join("|");
  return x === y;
}

function scoreQuestion(type, user, correct) {
  if (type !== "select_all") return Number(answersEqual(user, correct));

  const correctKeys = new Set(correct);
  const selectedKeys = new Set(user);
  if (!correctKeys.size || [...selectedKeys].some(key => !correctKeys.has(key))) return 0;
  return selectedKeys.size / correctKeys.size;
}

function abandonExam() {
  if (!state || state.mode !== "exam") return renderSetup();
  const msg = "End this exam and return to the main screen?\n\nProgress will be discarded and no result will be saved.";
  if (!confirm(msg)) return;
  state = null;
  clearSavedState();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  window.onbeforeunload = null;
  renderSetup();
}

function submitExam(auto = false) {
  if (!auto) {
    const unanswered = state.questions.filter(q => !(state.answers[q.id] || []).length).length;
    const flagged = Object.values(state.flagged).filter(Boolean).length;
    const msg = `Submit exam now?\n\nUnanswered: ${unanswered}\nFlagged: ${flagged}`;
    if (!confirm(msg)) return;
  }
  state.submittedAt = Date.now();
  saveAttemptToHistory(auto);
  state.mode = "results";
  clearSavedState();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  window.onbeforeunload = null;
  renderResults();
}

function gradeExam() {
  return state.questions.map(q => {
    const user = state.answers[q.id] || [];
    const correct = q.correctAnswers || normalizeCorrectAnswer(q);
    const pointsEarned = scoreQuestion(q.type, user, correct);
    return { q, user, correct, pointsEarned, isCorrect: pointsEarned === 1 };
  });
}

function totalPoints(graded) {
  return graded.reduce((total, result) => total + result.pointsEarned, 0);
}

function buildModuleStats(graded) {
  const byModule = {};
  for (const g of graded) {
    const m = g.q.module;
    byModule[m] ||= { correct: 0, pointsEarned: 0, total: 0 };
    byModule[m].total++;
    byModule[m].pointsEarned += g.pointsEarned;
    if (g.isCorrect) byModule[m].correct++;
  }
  return byModule;
}

function buildQuestionRefsByModule() {
  const refs = {};
  for (const q of state.questions) {
    refs[q.module] ||= [];
    refs[q.module].push(questionRef(q));
  }
  for (const module of Object.keys(refs)) {
    refs[module].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }
  return refs;
}

function buildQuestionResults(graded) {
  return graded.map(g => ({
    id: g.q.id,
    module: g.q.module,
    number: g.q.number,
    isCorrect: g.isCorrect,
    user: g.user,
    correct: g.correct
  }));
}

function saveAttemptToHistory(autoSubmitted) {
  const graded = gradeExam();
  const correctCount = graded.filter(g => g.isCorrect).length;
  const questionCount = graded.length;
  const attempt = {
    id: `${state.submittedAt}-${Math.random().toString(16).slice(2)}`,
    schemaVersion: 4,
    startedAt: state.startedAt,
    submittedAt: state.submittedAt,
    elapsedMs: Math.max(0, state.submittedAt - state.startedAt),
    durationMs: state.durationMs,
    autoSubmitted,
    questionCount,
    correctCount,
    pointsEarned: totalPoints(graded),
    moduleStats: buildModuleStats(graded),
    questionRefsByModule: buildQuestionRefsByModule(),
    questionResults: buildQuestionResults(graded),
    distribution: state.distribution || null,
    questionCountSetting: state.questionCountSetting || null,
    sourceMode: state.sourceMode || "all"
  };
  const history = loadHistory();
  history.push(attempt);
  saveHistory(history);
}

function renderResults(filter = "all") {
  $("setup").hidden = true;
  $("exam").hidden = true;
  $("results").hidden = false;
  $("timer").hidden = true;
  const graded = gradeExam();
  const elapsed = state.submittedAt ? Math.max(0, state.submittedAt - state.startedAt) : 0;
  $("scoreSummary").innerHTML = `
    <div class="score-big">${formatScore(totalPoints(graded), graded.length)}</div>
    <div>Elapsed time: ${formatDuration(elapsed)}</div>
  `;
  const byModule = buildModuleStats(graded);
  $("moduleResults").innerHTML = Object.entries(byModule).sort(([a], [b]) => a.localeCompare(b)).map(([module, r]) => {
    return `<div><strong>${module}</strong><br>${formatScore(r.pointsEarned, r.total)}</div>`;
  }).join("");
  renderReview(filter);
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatAnswer(q, keys) {
  if (!keys || !keys.length) return "No answer";
  return keys.map(k => `${k}: ${q.choices[k] ?? k}`).join("; ");
}

function renderReview(filter = "all") {
  const graded = gradeExam();
  const shown = filter === "missed" ? graded.filter(g => !g.isCorrect) : graded;
  $("reviewList").innerHTML = shown.map((g) => {
    const q = g.q;
    const imageHtml = (q.images || []).map(src => `<img src="${src}" alt="Question figure">`).join("");
    let status = '<span class="wrong-text">Incorrect</span>';
    if (g.isCorrect) status = '<span class="correct-text">Correct</span>';
    else if (g.pointsEarned > 0) status = `Partial credit (${formatPercent(g.pointsEarned, 1)})`;
    const gradeClass = g.isCorrect ? ' correct' : g.pointsEarned === 0 ? ' wrong' : '';
    return `<article class="review-card${gradeClass}">
      <h3>${escapeHtml(q.module)} / Source Q${q.number}: ${status}</h3>
      <p>${escapeHtml(q.prompt)}</p>
      ${imageHtml ? `<div class="question-images">${imageHtml}</div>` : ''}
      <p class="answer-line"><span class="label">Your answer:</span> ${escapeHtml(formatAnswer(q, g.user))}</p>
      <p class="answer-line"><span class="label">Correct answer:</span> ${escapeHtml(formatAnswer(q, g.correct))}</p>
      ${q.explanation ? `<div class="explanation"><strong>Why:</strong> ${escapeHtml(q.explanation)}</div>` : ''}
    </article>`;
  }).join("") || `<p>No questions to show.</p>`;
}

async function init() {
  const res = await fetch('questions.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Question bank request failed (${res.status}).`);
  const data = await res.json();
  questionBank = data.questions;
  if (!questionBank.length) {
    $("bankSummary").textContent = "No active question bank";
    $("emptyBank").hidden = false;
    return;
  }
  questionLookup = new Map(questionBank.map(q => [q.id, q]));
  meta = data.meta;
  renderSetup();

  $("startExam").addEventListener("click", startExam);
  $("resumeExam").addEventListener("click", resumeExam);
  $("clearSaved").addEventListener("click", () => { clearSavedState(); renderSetup(); });
  $("clearHistory").addEventListener("click", clearHistory);
  $("questionSource").addEventListener("change", renderSetupAvailability);
  $("prevQuestion").addEventListener("click", () => {
    if (state.currentIndex > 0) state.currentIndex--;
    saveState(); renderQuestionNav(); renderQuestion();
  });
  $("nextQuestion").addEventListener("click", () => {
    if (state.currentIndex < state.questions.length - 1) state.currentIndex++;
    saveState(); renderQuestionNav(); renderQuestion();
  });
  $("flagQuestion").addEventListener("click", () => {
    const q = state.questions[state.currentIndex];
    state.flagged[q.id] = !state.flagged[q.id];
    saveState(); renderQuestionNav(); renderQuestion();
  });
  $("submitExam").addEventListener("click", () => submitExam(false));
  $("abandonExam").addEventListener("click", abandonExam);
  $("newExam").addEventListener("click", () => { state = null; renderSetup(); });
  $("reviewMissed").addEventListener("click", () => renderResults("missed"));
  $("reviewAll").addEventListener("click", () => renderResults("all"));
}

init().catch(err => {
  console.error(err);
  document.body.innerHTML = `<main class="panel"><h1>Error loading app</h1><p>If you opened index.html directly, run it through a local server instead:</p><pre>python3 -m http.server 8000</pre><p>Then open http://localhost:8000</p><pre>${escapeHtml(err.stack || err.message || err)}</pre></main>`;
});
