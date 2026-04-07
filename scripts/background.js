// background.js (Service Worker)
// ──────────────────────────────────────────────────────────────
// 문제 데이터 수신 → 중복 체크 → solved.ac 보강 → 백엔드 전송
// + On-Demand 크롤링 관리 (pendingCrawls)
// ──────────────────────────────────────────────────────────────

const API_BASE = "https://ujax.kro.kr";
const PROBLEM_INGEST_PATH = "/api/v1/problems/ingest";
const SUBMISSION_INGEST_PATH = "/api/v1/submissions/ingest";

// UJAX 프론트엔드 URL 패턴
const UJAX_FRONT_ORIGIN = "https://ujax.kro.kr";
const UJAX_FRONT_URLS = [`${UJAX_FRONT_ORIGIN}/*`];
const MAX_CRAWLED_PROBLEMS = 3000;
const MAX_SENT_SUBMISSIONS = 5000;
const SUBMIT_RUNTIME_STATE_KEY = "submitRuntimeState";
const SUBMIT_RUNTIME_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const ACTIVE_SUBMISSION_FLOW_KEY = "activeSubmissionFlow";
const ACTIVE_SUBMISSION_FLOW_MAX_AGE_MS = 10 * 60 * 1000;
const PENDING_SOURCE_REQUESTS_KEY = "pendingSourceRequests";

function isUjaxFrontUrl(url) {
  return (
    typeof url === "string" &&
    (url === UJAX_FRONT_ORIGIN || url.startsWith(`${UJAX_FRONT_ORIGIN}/`))
  );
}

function isBojStatusUrl(url) {
  return /^https:\/\/www\.acmicpc\.net\/status(?:[/?#]|$)/.test(String(url || ""));
}

function normalizeBojId(value) {
  return String(value || "").trim().toLowerCase();
}

function parsePositiveProblemNum(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

async function injectBridgeToTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["scripts/ujaxBridge.js"],
    });
  } catch {
    // 권한/탭 상태에 따라 실패할 수 있음 (무시)
  }
}

async function ensureBridgeInjected(tabId) {
  if (tabId) {
    await injectBridgeToTab(tabId);
    return;
  }

  try {
    const tabs = await chrome.tabs.query({ url: UJAX_FRONT_URLS });
    await Promise.all(tabs.map((tab) => injectBridgeToTab(tab.id)));
  } catch {
    // 탭 조회 실패 시 무시
  }
}

// solved.ac 티어 매핑 (0~30)
const TIER_NAMES = [
  "Unrated",
  "Bronze V", "Bronze IV", "Bronze III", "Bronze II", "Bronze I",
  "Silver V", "Silver IV", "Silver III", "Silver II", "Silver I",
  "Gold V", "Gold IV", "Gold III", "Gold II", "Gold I",
  "Platinum V", "Platinum IV", "Platinum III", "Platinum II", "Platinum I",
  "Diamond V", "Diamond IV", "Diamond III", "Diamond II", "Diamond I",
  "Ruby V", "Ruby IV", "Ruby III", "Ruby II", "Ruby I",
];

// ──────────────────────────────────────────────────────────────
// 중복 크롤링 방지 캐시
// ──────────────────────────────────────────────────────────────

async function getCrawledSet() {
  const { crawledProblems } = await chrome.storage.local.get("crawledProblems");
  return new Set(crawledProblems || []);
}

async function addToCrawledSet(problemNum) {
  const set = await getCrawledSet();
  set.add(problemNum);
  const next = [...set];
  if (next.length > MAX_CRAWLED_PROBLEMS) {
    next.splice(0, next.length - MAX_CRAWLED_PROBLEMS);
  }
  await chrome.storage.local.set({ crawledProblems: next });
}

async function isAlreadyCrawled(problemNum) {
  const set = await getCrawledSet();
  return set.has(problemNum);
}

// ──────────────────────────────────────────────────────────────
// On-Demand 크롤링: pendingCrawls 관리
// ──────────────────────────────────────────────────────────────

async function addToPendingCrawls(problemNum) {
  const { pendingCrawls } = await chrome.storage.local.get("pendingCrawls");
  const pending = pendingCrawls || [];
  if (!pending.includes(problemNum)) {
    pending.push(problemNum);
    await chrome.storage.local.set({ pendingCrawls: pending });
  }
}

// ──────────────────────────────────────────────────────────────
// 크롤링 완료를 UJAX 프론트엔드에 알림
// ──────────────────────────────────────────────────────────────

async function notifyFrontend(problemNum, success, reason) {
  try {
    const tabs = await chrome.tabs.query({
      url: UJAX_FRONT_URLS,
    });
    const msg = { type: "crawlComplete", problemNum, success };
    if (reason) msg.reason = reason;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => { });
    }
  } catch {
    // 프론트엔드 탭이 없으면 무시
  }
}

async function notifySubmissionResult(data) {
  try {
    const tabs = await chrome.tabs.query({ url: UJAX_FRONT_URLS });
    console.log(`[UJAX] 프론트엔드 탭 ${tabs.length}개 발견`);

    const payload = {
      type: "ujaxSubmissionResult",
      problemNum: data.problemNum,
      verdict: data.verdict,
      submissionId: data.submissionId,
      time: data.time || "",
      memory: data.memory || "",
      language: data.language || "",
      reasonCode: data.reasonCode || null,
    };

    for (const tab of tabs) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (msg, targetOrigin) => { window.postMessage(msg, targetOrigin); },
        args: [payload, UJAX_FRONT_ORIGIN],
      });
    }
    console.log(`[UJAX] 프론트엔드에 결과 전달: ${data.submissionId}번 (${data.verdict})`);
  } catch (err) {
    console.error(`[UJAX] 프론트엔드 결과 전달 실패:`, err);
  }
}

async function notifySubmissionSkip(data, reason) {
  await notifySubmissionResult({
    problemNum: data.problemNum,
    verdict: reason,
    submissionId: data.submissionId || "N/A",
    time: "",
    memory: "",
    language: data.language || "",
    reasonCode: data.reasonCode || "SUBMISSION_SKIP",
  });
}

// ──────────────────────────────────────────────────────────────
// solved.ac API로 티어/태그 보강
// ──────────────────────────────────────────────────────────────
async function fetchSolvedAcMetadata(problemNum) {
  try {
    const res = await fetch(
      `https://solved.ac/api/v3/problem/show?problemId=${problemNum}`
    );
    if (!res.ok) return { tier: "Unrated", tags: [] };
    const data = await res.json();

    const tier =
      typeof data.level === "number" && TIER_NAMES[data.level]
        ? TIER_NAMES[data.level]
        : "Unrated";

    const tags = (data.tags || []).map((t) => {
      const ko = (t.displayNames || []).find((d) => d.language === "ko");
      return ko ? ko.name : t.displayNames?.[0]?.name || "";
    }).filter(Boolean);

    return { tier, tags };
  } catch {
    return { tier: "Unrated", tags: [] };
  }
}

// ──────────────────────────────────────────────────────────────
// 백엔드 API 전송
// ──────────────────────────────────────────────────────────────

// UJAX 프론트 탭에서 refresh 엔드포인트를 호출해 새 accessToken 발급
async function getFreshTokenFromPage() {
  try {
    const tabs = await chrome.tabs.query({ url: UJAX_FRONT_URLS });
    if (tabs.length === 0) return null;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: "MAIN",
      func: async () => {
        try {
          const auth = JSON.parse(localStorage.getItem("auth") || "{}");
          if (!auth.refreshToken) return null;

          // 페이지 컨텍스트에서 refresh 호출 (dev proxy 경유)
          const res = await fetch("/api/v1/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: auth.refreshToken }),
          });
          if (!res.ok) return null;

          const { data } = await res.json();
          // localStorage 갱신
          localStorage.setItem("auth", JSON.stringify({
            ...auth,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          }));
          // 프론트 Recoil에도 동기화
          window.postMessage({ type: "ujaxTokenRefreshed", token: data.accessToken }, location.origin);
          return data.accessToken;
        } catch {
          return null;
        }
      },
    });

    const token = result?.result || null;
    if (token) await chrome.storage.local.set({ ujaxToken: token });
    return token;
  } catch {
    return null;
  }
}

async function sendToBackend(path, payload, { requireAuth = false } = {}) {
  const headers = { "Content-Type": "application/json" };

  if (requireAuth) {
    const { ujaxToken } = await chrome.storage.local.get("ujaxToken");
    if (!ujaxToken) {
      console.warn("[UJAX] 토큰 없음, 전송 스킵");
      return { ok: false, status: 0, skipped: true };
    }
    headers["Authorization"] = `Bearer ${ujaxToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return res;
}

// ──────────────────────────────────────────────────────────────
// 메시지 핸들러
// ──────────────────────────────────────────────────────────────

// 제출 중복 방지 캐시
async function getSentSubmissionSet() {
  const { sentSubmissions } = await chrome.storage.local.get("sentSubmissions");
  return new Set(sentSubmissions || []);
}

async function addToSentSubmissionSet(submissionId) {
  const set = await getSentSubmissionSet();
  set.add(submissionId);
  const next = [...set];
  if (next.length > MAX_SENT_SUBMISSIONS) {
    next.splice(0, next.length - MAX_SENT_SUBMISSIONS);
  }
  await chrome.storage.local.set({ sentSubmissions: next });
}

async function isAlreadySentSubmission(submissionId) {
  const set = await getSentSubmissionSet();
  return set.has(submissionId);
}

// ──────────────────────────────────────────────────────────────
// 문제 컨텍스트 매핑: problemNum → workspaceProblemId
// ──────────────────────────────────────────────────────────────

async function setProblemContext(problemNum, workspaceProblemId) {
  const { problemContextMap } = await chrome.storage.local.get("problemContextMap");
  const map = problemContextMap || {};
  map[String(problemNum)] = workspaceProblemId;
  await chrome.storage.local.set({ problemContextMap: map });
}

async function getWorkspaceProblemId(problemNum) {
  const { problemContextMap } = await chrome.storage.local.get("problemContextMap");
  return problemContextMap?.[String(problemNum)] ?? null;
}

async function waitForWorkspaceProblemId(problemNum, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const id = await getWorkspaceProblemId(problemNum);
    if (id) return id;
    await sleep(250);
  }
  return null;
}

async function getPendingSourceRequestsMap() {
  const { [PENDING_SOURCE_REQUESTS_KEY]: pendingSourceRequests } = await chrome.storage.local.get(
    PENDING_SOURCE_REQUESTS_KEY
  );
  if (!pendingSourceRequests || typeof pendingSourceRequests !== "object") {
    return {};
  }
  return pendingSourceRequests;
}

async function setPendingSourceRequest(submissionId, request) {
  const key = String(submissionId || "");
  if (!key) return;
  const map = await getPendingSourceRequestsMap();
  map[key] = request;
  await chrome.storage.local.set({ [PENDING_SOURCE_REQUESTS_KEY]: map });
}

async function getPendingSourceRequest(submissionId) {
  const key = String(submissionId || "");
  if (!key) return null;
  const map = await getPendingSourceRequestsMap();
  return map[key] || null;
}

async function removePendingSourceRequest(submissionId) {
  const key = String(submissionId || "");
  if (!key) return;
  const map = await getPendingSourceRequestsMap();
  if (!map[key]) return;
  delete map[key];
  if (Object.keys(map).length === 0) {
    await chrome.storage.local.remove(PENDING_SOURCE_REQUESTS_KEY);
    return;
  }
  await chrome.storage.local.set({ [PENDING_SOURCE_REQUESTS_KEY]: map });
}

async function clearAllPendingSourceRequests() {
  await chrome.storage.local.remove(PENDING_SOURCE_REQUESTS_KEY);
}

async function setActiveSubmissionFlow(flow) {
  await chrome.storage.local.set({
    [ACTIVE_SUBMISSION_FLOW_KEY]: {
      ...flow,
      createdAt: Date.now(),
    },
  });
}

async function getActiveSubmissionFlow() {
  const { [ACTIVE_SUBMISSION_FLOW_KEY]: flow } = await chrome.storage.local.get(ACTIVE_SUBMISSION_FLOW_KEY);
  if (!flow || typeof flow !== "object") {
    return null;
  }
  return flow;
}

async function clearActiveSubmissionFlow() {
  await chrome.storage.local.remove(ACTIVE_SUBMISSION_FLOW_KEY);
}

const inFlightSubmissionIds = new Set();
const recentSubmissionSkipMap = new Map();
const SUBMISSION_SKIP_DEDUPE_MS = 15_000;

function buildSubmissionSkipKey(data) {
  const reasonCode = String(data?.reasonCode || "SUBMISSION_SKIP");
  const problemNum = Number(data?.problemNum || pendingSubmitProblemNum || 0) || 0;
  const detectedUsername = normalizeBojId(data?.detectedUsername || data?.username || "");
  const expectedBojId = normalizeBojId(pendingSubmitExpectedBojId || "");
  return `${reasonCode}|${problemNum}|${detectedUsername}|${expectedBojId}`;
}

function isDuplicateSubmissionSkip(data) {
  const now = Date.now();
  for (const [key, ts] of recentSubmissionSkipMap.entries()) {
    if (now - ts > SUBMISSION_SKIP_DEDUPE_MS) {
      recentSubmissionSkipMap.delete(key);
    }
  }

  const key = buildSubmissionSkipKey(data);
  const prev = recentSubmissionSkipMap.get(key);
  if (prev && now - prev <= SUBMISSION_SKIP_DEDUPE_MS) {
    return true;
  }

  recentSubmissionSkipMap.set(key, now);
  return false;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "problemData") {
    handleProblemData(message.data, sender.tab?.id);
    return true; // SW를 살려두기 위해 async 핸들러는 반드시 true 반환
  }

  if (message?.type === "submissionData") {
    handleSubmissionData(message.data, sender.tab?.id);
    return true; // SW를 살려두기 위해 async 핸들러는 반드시 true 반환
  }

  if (message?.type === "submissionSkip") {
    if (isDuplicateSubmissionSkip(message.data)) {
      console.log("[UJAX] submissionSkip 중복 수신 무시");
      return true;
    }
    handleSubmissionSkip(message.data, sender.tab?.id);
    return true; // SW를 살려두기 위해 async 핸들러는 반드시 true 반환
  }

  // sourceContent.js에서 소스 코드 수신
  if (message?.type === "sourceCode") {
    const sid = String(message.submissionId || "");
    const entry = pendingSource.get(sid);
    if (entry) {
      entry.resolve(message.code || "");
      try { chrome.tabs.remove(entry.tabId); } catch { }
      pendingSource.delete(sid);
      removePendingSourceRequest(sid).catch(() => { });
      console.log(`[UJAX] 소스 코드 수신 완료: ${sid}번 (${(message.code || "").length}자)`);
    } else {
      handleOrphanedSourceCode(sid, message.code || "", sender.tab?.id).catch((err) => {
        console.error("[UJAX] orphan sourceCode 복구 처리 실패:", err);
      });
    }
    return true;
  }

  // 팝업 수동 크롤링
  if (message?.type === "manualCrawl") {
    const problemNum = parsePositiveProblemNum(message.problemNum);
    if (!problemNum) {
      console.warn("[UJAX] manualCrawl 무시: 유효하지 않은 problemNum", message.problemNum);
      return true;
    }
    addToPendingCrawls(problemNum).then(() => {
      chrome.tabs.create({
        url: `https://www.acmicpc.net/problem/${problemNum}`,
        active: true,
      });
    }).catch((err) => console.error("[UJAX] manualCrawl 오류:", err));
    return true;
  }

  // 프론트엔드(ujaxBridge.js)에서 요청한 on-demand 크롤링
  if (message?.type === "crawlRequest") {
    const problemNum = parsePositiveProblemNum(message.problemNum);
    if (!problemNum) {
      console.warn("[UJAX] crawlRequest 무시: 유효하지 않은 problemNum", message.problemNum);
      return true;
    }
    addToPendingCrawls(problemNum).then(() => {
      chrome.tabs.create({
        url: `https://www.acmicpc.net/problem/${problemNum}`,
        active: false,
      });
    }).catch((err) => console.error("[UJAX] crawlRequest 오류:", err));
    return true;
  }

  // UJAX 토큰 수신 (ujaxBridge.js)
  if (message?.type === "ujaxToken") {
    const updates = { ujaxToken: message.token };
    if (Object.prototype.hasOwnProperty.call(message, "bojId")) {
      const frontBojId = normalizeBojId(message.bojId);
      updates.frontBojId = frontBojId || null;
    }
    if (message.token) {
      chrome.storage.local.set(updates);
    } else {
      chrome.storage.local.remove([
        "ujaxToken",
        "frontBojId",
        "expectedSubmissionBojId",
        "expectedSubmissionProblemNum",
        "expectingSubmission",
      ]);
    }
    return true;
  }

  // 문제 컨텍스트 수신 (ujaxBridge.js → Frontend)
  if (message?.type === "problemContext") {
    setProblemContext(message.problemNum, message.workspaceProblemId);
    console.log(`[UJAX] 문제 컨텍스트 저장: ${message.problemNum} → wpId=${message.workspaceProblemId}`);
    return true;
  }

  // 제출 요청 수신 (ujaxBridge.js → Frontend)
  if (message?.type === "submitRequest") {
    handleSubmitRequest(message);
    return true; // SW를 살려두기 위해 async 핸들러는 반드시 true 반환
  }
});

async function closeCrawlTab(tabId) {
  if (tabId) {
    chrome.tabs.remove(tabId).catch(() => { });
  }
}

async function handleProblemData(data, senderTabId) {
  const problemNum = Number(data.problemNum);
  if (!problemNum || !data.title) {
    console.warn(`[UJAX] 크롤링 실패: 유효하지 않은 데이터 (problemNum=${data.problemNum})`);
    if (problemNum) await notifyFrontend(problemNum, false, "NOT_FOUND");
    closeCrawlTab(senderTabId);
    return;
  }

  if (await isAlreadyCrawled(problemNum)) {
    console.log(`[UJAX] 스킵: ${problemNum}번 (이미 수집됨)`);
    await notifyFrontend(problemNum, true);
    closeCrawlTab(senderTabId);
    return;
  }

  const solvedAc = await fetchSolvedAcMetadata(problemNum);

  const contentTags = Array.isArray(data.tags) ? data.tags : [];
  const mergedTags = solvedAc.tags.length > 0 ? solvedAc.tags : contentTags;

  const payload = {
    problemNum: problemNum,
    title: data.title,
    tier: solvedAc.tier,
    timeLimit: data.timeLimit || "",
    memoryLimit: data.memoryLimit || "",
    problemDesc: data.description || "",
    problemInput: data.inputDescription || "",
    problemOutput: data.outputDescription || "",
    url: data.url || `https://www.acmicpc.net/problem/${problemNum}`,
    samples: (data.samples || []).map((s) => ({
      sampleIndex: s.sampleIndex,
      input: s.input || "",
      output: s.output || "",
    })),
    tags: mergedTags.map((name) => ({ name: String(name) })),
  };

  try {
    const res = await sendToBackend(PROBLEM_INGEST_PATH, payload);

    if (res.ok) {
      await addToCrawledSet(problemNum);
      console.log(`[UJAX] 등록 완료: ${problemNum}번 ${data.title}`);
      await notifyFrontend(problemNum, true);
    } else if (res.status === 409) {
      await addToCrawledSet(problemNum);
      console.log(`[UJAX] 이미 등록됨: ${problemNum}번 (캐시 갱신)`);
      await notifyFrontend(problemNum, true);
    } else {
      console.warn(`[UJAX] 등록 실패: ${problemNum}번 (HTTP ${res.status})`);
      await notifyFrontend(problemNum, false, "SERVER_ERROR");
    }
  } catch (err) {
    console.error(`[UJAX] 네트워크 오류: ${problemNum}번`, err);
    await notifyFrontend(problemNum, false, "NETWORK_ERROR");
  }

  closeCrawlTab(senderTabId);
}

// ──────────────────────────────────────────────────────────────
// 제출 데이터 처리 (소스 코드는 탭을 열어 content script로 수집)
// ──────────────────────────────────────────────────────────────

const pendingSource = new Map();

function openSourceTabAndGetCode(submissionId) {
  const sid = String(submissionId);
  return new Promise((resolve) => {
    chrome.tabs.create(
      { url: `https://www.acmicpc.net/source/${sid}`, active: false },
      (tab) => {
        if (!tab?.id) return resolve("");
        pendingSource.set(sid, { resolve, tabId: tab.id });
        setPendingSourceRequest(sid, { tabId: tab.id, createdAt: Date.now() }).catch(() => { });

        // 8초 타임아웃
        setTimeout(() => {
          const entry = pendingSource.get(sid);
          if (entry) {
            entry.resolve("");
            try { chrome.tabs.remove(tab.id); } catch { }
            pendingSource.delete(sid);
            removePendingSourceRequest(sid).catch(() => { });
            console.warn(`[UJAX] 소스 코드 수집 타임아웃: ${sid}번`);
          }
        }, 8000);
      }
    );
  });
}

async function closeSubmitFlowTabs(statusTabId) {
  await sleep(500);

  const ujaxTabs = await chrome.tabs.query({ url: UJAX_FRONT_URLS });
  const ujaxTabId = ujaxTabs[0]?.id ?? null;

  const tabIds = new Set();
  if (statusTabId) tabIds.add(statusTabId);
  if (lastSubmitTabId) tabIds.add(lastSubmitTabId);

  for (const id of tabIds) {
    try { await chrome.tabs.remove(id); } catch { }
  }

  clearSubmitStatusArmWatcher();
  try {
    await chrome.storage.local.remove([
      "expectedSubmissionBojId",
      "expectedSubmissionProblemNum",
      "expectingSubmission",
    ]);
  } catch { }
  pendingSubmitExpectedBojId = null;
  pendingSubmitProblemNum = null;
  lastSubmitTabId = null;
  await clearSubmitRuntimeState();
  await clearActiveSubmissionFlow();
  await clearAllPendingSourceRequests();

  if (tabIds.size > 0) {
    console.log(`[UJAX] 백준 탭 ${tabIds.size}개 닫기 완료`);
  }

  if (ujaxTabId) {
    chrome.tabs.update(ujaxTabId, { active: true });
    console.log(`[UJAX] UJAX 탭으로 포커스 복귀: ${ujaxTabId}`);
  }
}

async function handleSubmissionSkip(data, statusTabId) {
  const problemNum = Number(data?.problemNum || pendingSubmitProblemNum || 0) || null;
  const reasonCode = data?.reasonCode || "SUBMISSION_SKIP";
  const reasonMessage = data?.reasonMessage || "[UJAX] 제출 확인 실패: 잠시 후 다시 시도해주세요.";

  await notifySubmissionSkip(
    {
      problemNum,
      submissionId: data?.submissionId || "N/A",
      language: data?.language || "",
      reasonCode,
    },
    reasonMessage
  );
  await closeSubmitFlowTabs(statusTabId);
}

async function ingestSubmissionRecord({ submissionId, workspaceProblemId, data, code }) {
  const payload = {
    workspaceProblemId,
    submissionId: submissionId,
    verdict: data.verdict,
    time: data.time || "",
    memory: data.memory || "",
    language: data.language || "",
    codeLength: data.codeLength || "",
    code: code || "",
  };

  try {
    const res = await sendToBackend(SUBMISSION_INGEST_PATH, payload, { requireAuth: true });

    if (res.skipped) {
      await notifySubmissionSkip(
        { ...data, submissionId, reasonCode: "AUTH_REQUIRED" },
        "[UJAX] 제출 확인 실패: 로그인 상태를 확인하고 다시 시도해주세요."
      );
      return;
    }

    if (res.ok) {
      await addToSentSubmissionSet(submissionId);
      console.log(`[UJAX] 제출 등록 완료: ${submissionId}번 (${data.verdict})`);
      await notifySubmissionResult(data);
    } else if (res.status === 409) {
      await addToSentSubmissionSet(submissionId);
      console.log(`[UJAX] 제출 이미 등록됨: ${submissionId}번 (캐시 갱신)`);
      await notifySubmissionResult(data);
    } else if (res.status === 401) {
      console.warn(`[UJAX] 토큰 만료, 페이지에서 최신 토큰 재시도 (제출 ${submissionId}번)`);
      const freshToken = await getFreshTokenFromPage();
      if (freshToken) {
        const retryRes = await fetch(`${API_BASE}${SUBMISSION_INGEST_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${freshToken}` },
          body: JSON.stringify(payload),
        });
        if (retryRes.ok || retryRes.status === 409) {
          await addToSentSubmissionSet(submissionId);
          console.log(`[UJAX] 토큰 갱신 후 재시도 성공: ${submissionId}번`);
          await notifySubmissionResult(data);
        } else {
          console.warn(`[UJAX] 재시도 실패: ${submissionId}번 (HTTP ${retryRes.status})`);
          await notifySubmissionSkip(
            { ...data, submissionId, reasonCode: "BACKEND_RETRY_FAILED" },
            `[UJAX] 제출 등록 실패: 서버 응답(${retryRes.status})으로 인해 결과를 동기화하지 못했습니다.`
          );
        }
      } else {
        await chrome.storage.local.remove("ujaxToken");
        console.warn(`[UJAX] 로그인 필요 (제출 ${submissionId}번 스킵)`);
        await notifySubmissionSkip(
          { ...data, submissionId, reasonCode: "AUTH_REQUIRED" },
          "[UJAX] 제출 확인 실패: 로그인 상태를 확인하고 다시 시도해주세요."
        );
      }
    } else {
      console.warn(`[UJAX] 제출 등록 실패: ${submissionId}번 (HTTP ${res.status})`);
      await notifySubmissionSkip(
        { ...data, submissionId, reasonCode: "SUBMISSION_INGEST_FAILED" },
        `[UJAX] 제출 등록 실패: 서버 응답(${res.status})으로 인해 결과를 동기화하지 못했습니다.`
      );
    }
  } catch (err) {
    console.error(`[UJAX] 제출 네트워크 오류: ${submissionId}번`, err);
    console.error(`[UJAX] 오류 상세: name=${err.name}, message=${err.message}, stack=`, err.stack);
    await notifySubmissionSkip(
      { ...data, submissionId, reasonCode: "NETWORK_ERROR" },
      "[UJAX] 제출 등록 중 네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요."
    );
  }
}

async function handleSubmissionData(data, statusTabId) {
  const submissionId = Number(data.submissionId);
  if (!submissionId) return;
  if (inFlightSubmissionIds.has(submissionId)) {
    console.log(`[UJAX] submissionData 중복 처리 무시: ${submissionId}번`);
    return;
  }
  inFlightSubmissionIds.add(submissionId);

  try {
    const rowUsername = normalizeBojId(data.username);
    const rowProblemNum = Number(data.problemNum || 0) || null;
    const { expectedSubmissionBojId, expectedSubmissionProblemNum } = await chrome.storage.local.get([
      "expectedSubmissionBojId",
      "expectedSubmissionProblemNum",
    ]);
    const expectedBojId = normalizeBojId(expectedSubmissionBojId || pendingSubmitExpectedBojId);
    const expectedProblemNum = Number(expectedSubmissionProblemNum || pendingSubmitProblemNum || 0) || null;

    if (!rowUsername) {
      console.warn(`[UJAX] 제출 스킵: ${submissionId}번 (status username 누락)`);
      await notifySubmissionSkip(
        { ...data, reasonCode: "STATUS_USERNAME_MISSING" },
        "[UJAX] 제출 확인 실패: status 사용자 정보를 읽지 못했습니다."
      );
      await closeSubmitFlowTabs(statusTabId);
      return;
    }

    if (!expectedBojId) {
      console.warn(`[UJAX] 제출 스킵: ${submissionId}번 (프론트 기준 BOJ 아이디 없음, username=${rowUsername})`);
      await notifySubmissionSkip(
        { ...data, reasonCode: "MISSING_BOJ_ID" },
        "[UJAX] 제출 확인 실패: 설정 > 프로필에서 백준 아이디를 확인해주세요."
      );
      await closeSubmitFlowTabs(statusTabId);
      return;
    }

    if (rowUsername !== expectedBojId) {
      console.warn(
        `[UJAX] 제출 스킵: ${submissionId}번 (아이디 불일치, row=${rowUsername}, expected=${expectedBojId})`
      );
      await notifySubmissionSkip(
        { ...data, reasonCode: "BOJ_ID_MISMATCH" },
        `[UJAX] 제출 확인 실패: BOJ 로그인 계정(${rowUsername})과 설정 아이디(${expectedBojId})가 다릅니다.`
      );
      await closeSubmitFlowTabs(statusTabId);
      return;
    }

    if (expectedProblemNum && rowProblemNum && rowProblemNum !== expectedProblemNum) {
      console.warn(
        `[UJAX] 제출 스킵: ${submissionId}번 (문제 번호 불일치, row=${rowProblemNum}, expected=${expectedProblemNum})`
      );
      await notifySubmissionSkip(
        { ...data, reasonCode: "PROBLEM_MISMATCH" },
        `[UJAX] 제출 확인 실패: 제출 문제 번호(${rowProblemNum})가 현재 문제(${expectedProblemNum})와 다릅니다.`
      );
      await closeSubmitFlowTabs(statusTabId);
      return;
    }

    if (await isAlreadySentSubmission(submissionId)) {
      console.log(`[UJAX] 제출 스킵: ${submissionId}번 (이미 전송됨)`);
      await closeSubmitFlowTabs(statusTabId);
      return;
    }

    const contextProblemNum = expectedProblemNum || rowProblemNum;
    const workspaceProblemId = await waitForWorkspaceProblemId(contextProblemNum, 5000);
    if (!workspaceProblemId) {
      console.log(`[UJAX] 제출 스킵: ${submissionId}번 (문제 컨텍스트 없음, problemNum=${contextProblemNum})`);
      await notifySubmissionSkip(
        { ...data, reasonCode: "CONTEXT_DELAY" },
        "[UJAX] 제출 확인 실패: 문제 컨텍스트 동기화가 지연되고 있습니다. 잠시 후 다시 시도해주세요."
      );
      await closeSubmitFlowTabs(statusTabId);
      return;
    }

    await setActiveSubmissionFlow({
      submissionId,
      statusTabId: statusTabId || null,
      workspaceProblemId,
      data: {
        problemNum: contextProblemNum,
        verdict: data.verdict,
        time: data.time || "",
        memory: data.memory || "",
        language: data.language || "",
        codeLength: data.codeLength || "",
      },
    });

    console.log(`[UJAX] 소스 코드 수집 시작: ${submissionId}번 (언어: "${data.language}")`);
    const code = await openSourceTabAndGetCode(submissionId);
    await ingestSubmissionRecord({
      submissionId,
      workspaceProblemId,
      data: {
        problemNum: contextProblemNum,
        verdict: data.verdict,
        time: data.time || "",
        memory: data.memory || "",
        language: data.language || "",
        codeLength: data.codeLength || "",
      },
      code,
    });

    await closeSubmitFlowTabs(statusTabId);
  } finally {
    clearActiveSubmissionFlow().catch(() => { });
    removePendingSourceRequest(submissionId).catch(() => { });
    inFlightSubmissionIds.delete(submissionId);
  }
}

let isResumingSubmissionFlow = false;

async function handleOrphanedSourceCode(sid, code, sourceTabId) {
  if (!sid) return;
  console.log(`[UJAX] orphan sourceCode 수신: ${sid}번, 복구 처리 시도`);

  try {
    if (sourceTabId) {
      await chrome.tabs.remove(sourceTabId);
    }
  } catch { }

  await removePendingSourceRequest(sid);

  const activeFlow = await getActiveSubmissionFlow();
  if (!activeFlow || String(activeFlow.submissionId) !== String(sid)) {
    return;
  }

  const createdAt = Number(activeFlow.createdAt || 0);
  if (!createdAt || Date.now() - createdAt > ACTIVE_SUBMISSION_FLOW_MAX_AGE_MS) {
    await clearActiveSubmissionFlow();
    await closeSubmitFlowTabs(activeFlow.statusTabId || null);
    return;
  }

  const submissionId = Number(activeFlow.submissionId || 0);
  const workspaceProblemId = activeFlow.workspaceProblemId;
  if (!submissionId) {
    await clearActiveSubmissionFlow();
    return;
  }
  if (!workspaceProblemId) {
    await clearActiveSubmissionFlow();
    await closeSubmitFlowTabs(activeFlow.statusTabId || null);
    return;
  }
  if (inFlightSubmissionIds.has(submissionId)) {
    return;
  }

  inFlightSubmissionIds.add(submissionId);
  try {
    await ingestSubmissionRecord({
      submissionId,
      workspaceProblemId,
      data: activeFlow.data || {},
      code: code || "",
    });
    await closeSubmitFlowTabs(activeFlow.statusTabId || null);
  } finally {
    await clearActiveSubmissionFlow();
    await removePendingSourceRequest(submissionId);
    inFlightSubmissionIds.delete(submissionId);
  }
}

async function resumeActiveSubmissionFlowIfNeeded() {
  if (isResumingSubmissionFlow) return;
  const activeFlow = await getActiveSubmissionFlow();
  if (!activeFlow) return;

  const createdAt = Number(activeFlow.createdAt || 0);
  if (!createdAt || Date.now() - createdAt > ACTIVE_SUBMISSION_FLOW_MAX_AGE_MS) {
    await clearActiveSubmissionFlow();
    await clearAllPendingSourceRequests();
    await closeSubmitFlowTabs(activeFlow.statusTabId || null);
    return;
  }

  const submissionId = Number(activeFlow.submissionId || 0);
  const workspaceProblemId = activeFlow.workspaceProblemId;
  if (!submissionId) {
    await clearActiveSubmissionFlow();
    return;
  }
  if (!workspaceProblemId) {
    await clearActiveSubmissionFlow();
    await closeSubmitFlowTabs(activeFlow.statusTabId || null);
    return;
  }
  if (inFlightSubmissionIds.has(submissionId)) {
    return;
  }

  isResumingSubmissionFlow = true;
  inFlightSubmissionIds.add(submissionId);
  try {
    const pendingReq = await getPendingSourceRequest(submissionId);
    const sourceTabId = Number(pendingReq?.tabId || 0);
    if (sourceTabId) {
      try { await chrome.tabs.remove(sourceTabId); } catch { }
      await removePendingSourceRequest(submissionId);
    }

    console.log(`[UJAX] 중단된 제출 플로우 재개: ${submissionId}번`);
    const code = await openSourceTabAndGetCode(submissionId);
    await ingestSubmissionRecord({
      submissionId,
      workspaceProblemId,
      data: activeFlow.data || {},
      code,
    });
    await closeSubmitFlowTabs(activeFlow.statusTabId || null);
  } finally {
    await clearActiveSubmissionFlow();
    await removePendingSourceRequest(submissionId);
    inFlightSubmissionIds.delete(submissionId);
    isResumingSubmissionFlow = false;
  }
}

// ──────────────────────────────────────────────────────────────
// 자동 제출 처리
// chrome.scripting.executeScript를 사용하여 CSP 우회
// ──────────────────────────────────────────────────────────────

// 자동 제출로 열린 탭 ID (submit → status 리다이렉트 후에도 같은 탭)
let lastSubmitTabId = null;
let pendingSubmitExpectedBojId = null;
let pendingSubmitProblemNum = null;

const LANG_TO_BOJ = {
  javascript: "17", // Node.js
  python:     "28", // Python 3
  cpp:        "84", // C++17
  c:          "0",  // C99
  java:       "93", // Java 11
  csharp:     "86", // C#
  kotlin:     "69", // Kotlin (JVM)
};

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function persistSubmitRuntimeState() {
  try {
    await chrome.storage.local.set({
      [SUBMIT_RUNTIME_STATE_KEY]: {
        lastSubmitTabId: lastSubmitTabId || null,
        pendingSubmitExpectedBojId: pendingSubmitExpectedBojId || null,
        pendingSubmitProblemNum: pendingSubmitProblemNum || null,
        updatedAt: Date.now(),
      },
    });
  } catch {
    // 저장 실패 시 무시
  }
}

async function clearSubmitRuntimeState() {
  try {
    await chrome.storage.local.remove(SUBMIT_RUNTIME_STATE_KEY);
  } catch {
    // 삭제 실패 시 무시
  }
}

async function restoreSubmitRuntimeState() {
  try {
    const { [SUBMIT_RUNTIME_STATE_KEY]: state } = await chrome.storage.local.get(SUBMIT_RUNTIME_STATE_KEY);
    if (!state || typeof state !== "object") return;

    const updatedAt = Number(state.updatedAt || 0);
    if (!updatedAt || Date.now() - updatedAt > SUBMIT_RUNTIME_STATE_MAX_AGE_MS) {
      await clearSubmitRuntimeState();
      return;
    }

    const restoredTabId = parsePositiveProblemNum(state.lastSubmitTabId);
    const restoredBojId = normalizeBojId(state.pendingSubmitExpectedBojId);
    const restoredProblemNum = parsePositiveProblemNum(state.pendingSubmitProblemNum);

    let restoredTab = null;
    if (restoredTabId) {
      try {
        restoredTab = await chrome.tabs.get(restoredTabId);
      } catch {
        await clearSubmitRuntimeState();
        return;
      }
    }

    lastSubmitTabId = restoredTabId || null;
    pendingSubmitExpectedBojId = restoredBojId || null;
    pendingSubmitProblemNum = restoredProblemNum || null;

    if (lastSubmitTabId || pendingSubmitExpectedBojId || pendingSubmitProblemNum) {
      console.log(
        `[UJAX] 제출 런타임 상태 복구: tab=${lastSubmitTabId || "-"}, bojId=${pendingSubmitExpectedBojId || "-"}, problem=${pendingSubmitProblemNum || "-"}`
      );
    }

    if (!restoredTabId || !restoredTab) return;

    const currentUrl = String(restoredTab.url || "");
    if (isBojStatusUrl(currentUrl)) {
      await chrome.storage.local.set({
        expectingSubmission: true,
        expectedSubmissionBojId: pendingSubmitExpectedBojId,
        expectedSubmissionProblemNum: pendingSubmitProblemNum,
      });
      console.log(`[UJAX] 복구: status 페이지 감시 즉시 활성화 (tab=${restoredTabId})`);
      return;
    }

    if (/^https:\/\/www\.acmicpc\.net\/submit\//.test(currentUrl)) {
      armSubmissionCaptureOnStatusRedirect(restoredTabId);
      console.log(`[UJAX] 복구: submit→status 감시 재무장 (tab=${restoredTabId})`);
      return;
    }

    await clearSubmitRuntimeState();
    lastSubmitTabId = null;
    pendingSubmitExpectedBojId = null;
    pendingSubmitProblemNum = null;
  } catch {
    // 복구 실패 시 무시
  }
}

let submitStatusArmWatcher = null;

function clearSubmitStatusArmWatcher() {
  if (!submitStatusArmWatcher) return;
  try {
    chrome.tabs.onUpdated.removeListener(submitStatusArmWatcher.listener);
  } catch { }
  clearTimeout(submitStatusArmWatcher.timeoutId);
  submitStatusArmWatcher = null;
}

function armSubmissionCaptureOnStatusRedirect(tabId) {
  clearSubmitStatusArmWatcher();

  const listener = (updatedTabId, changeInfo, tab) => {
    if (updatedTabId !== tabId) return;
    const url = changeInfo.url || tab?.url || "";
    if (!isBojStatusUrl(url)) return;

    clearSubmitStatusArmWatcher();
    chrome.storage.local.set({
      expectingSubmission: true,
      expectedSubmissionBojId: pendingSubmitExpectedBojId,
      expectedSubmissionProblemNum: pendingSubmitProblemNum,
    }).then(() => {
      console.log(
        `[UJAX] 제출 감시 활성화: tab=${tabId}, bojId=${pendingSubmitExpectedBojId || "-"}, problem=${pendingSubmitProblemNum || "-"}`
      );
    }).catch(() => { });
  };

  chrome.tabs.onUpdated.addListener(listener);
  const timeoutId = setTimeout(() => {
    clearSubmitStatusArmWatcher();
  }, 5 * 60 * 1000);

  submitStatusArmWatcher = { listener, timeoutId };
}

async function handleSubmitRequest({ problemNum, code, language, expectedBojId }) {
  const normalizedProblemNum = parsePositiveProblemNum(problemNum);
  if (!normalizedProblemNum || !code) {
    console.warn("[UJAX] 제출 요청 데이터 부족");
    await notifySubmissionSkip(
      {
        problemNum: normalizedProblemNum || null,
        submissionId: "N/A",
        language,
        reasonCode: "SUBMIT_REQUEST_INVALID",
      },
      "[UJAX] 제출 확인 실패: 제출 요청 데이터가 올바르지 않습니다."
    );
    return;
  }

  if (lastSubmitTabId || submitStatusArmWatcher) {
    console.warn("[UJAX] 제출 스킵: 이전 제출 플로우 진행 중");
    await notifySubmissionSkip(
      { problemNum: normalizedProblemNum, submissionId: "N/A", language, reasonCode: "SUBMIT_FLOW_BUSY" },
      "[UJAX] 이전 제출 처리 중입니다. 잠시 후 다시 시도해주세요."
    );
    return;
  }

  clearSubmitStatusArmWatcher();
  const directExpectedId = normalizeBojId(expectedBojId);
  pendingSubmitProblemNum = normalizedProblemNum;
  if (directExpectedId) {
    pendingSubmitExpectedBojId = directExpectedId;
  } else {
    const { frontBojId } = await chrome.storage.local.get("frontBojId");
    pendingSubmitExpectedBojId = normalizeBojId(frontBojId) || null;
  }
  await persistSubmitRuntimeState();
  if (!pendingSubmitExpectedBojId) {
    console.warn("[UJAX] 제출 스킵: 프론트 기준 BOJ 아이디 없음");
    await notifySubmissionSkip(
      { problemNum: normalizedProblemNum, submissionId: "N/A", language, reasonCode: "MISSING_BOJ_ID" },
      "[UJAX] 제출 확인 실패: 설정 > 프로필에서 백준 아이디를 확인해주세요."
    );
    pendingSubmitExpectedBojId = null;
    pendingSubmitProblemNum = null;
    await clearSubmitRuntimeState();
    return;
  }

  console.log(`[UJAX] 자동 제출 시작: ${normalizedProblemNum}번 (${language})`);
  console.log(`[UJAX] 제출 사용자 기준: ${pendingSubmitExpectedBojId}`);
  await chrome.storage.local.remove([
    "expectingSubmission",
    "expectedSubmissionBojId",
    "expectedSubmissionProblemNum",
  ]);

  let submitTabId = null;
  try {
    // 1) 백준 제출 페이지 열기 + 로드 대기
    const tab = await chrome.tabs.create({
      url: `https://www.acmicpc.net/submit/${normalizedProblemNum}`,
      active: true,
    });
    submitTabId = tab?.id || null;
    if (!submitTabId) throw new Error("submit-tab-create-failed");
    lastSubmitTabId = submitTabId;
    await persistSubmitRuntimeState();
    await waitForTabLoad(submitTabId);
    await sleep(500); // 에디터 초기화 대기

    // 2) 언어 선택 (DOM 조작 — isolated world)
    const bojLangId = LANG_TO_BOJ[language];
    if (!bojLangId) {
      console.warn(`[UJAX] 지원하지 않는 언어: ${language}`);
      await notifySubmissionSkip(
        {
          problemNum: normalizedProblemNum,
          submissionId: "N/A",
          language,
          reasonCode: "UNSUPPORTED_LANGUAGE",
        },
        `[UJAX] 제출 확인 실패: 현재 언어(${language})는 자동 제출을 지원하지 않습니다.`
      );
      await closeSubmitFlowTabs(submitTabId);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: submitTabId },
      func: (langId) => {
        const select = document.getElementById("language");
        if (select) {
          select.value = langId;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("[UJAX] 언어 선택 완료:", langId);
        } else {
          console.warn("[UJAX] 언어 선택 드롭다운(#language)을 찾을 수 없음");
        }
      },
      args: [bojLangId],
    });
    await sleep(500); // 언어 변경 후 에디터 재초기화 대기

    // 3) 코드 입력 (Ace/CodeMirror 접근 — MAIN world 필수)
    await chrome.scripting.executeScript({
      target: { tabId: submitTabId },
      world: "MAIN",
      func: (code) => {
        var filled = false;

        // Ace Editor
        var aceEl = document.querySelector(".ace_editor");
        if (aceEl && window.ace) {
          var editor = window.ace.edit(aceEl);
          editor.setValue(code, -1);
          editor.clearSelection();
          filled = true;
          console.log("[UJAX] Ace Editor 코드 입력 완료");
        }

        // CodeMirror 5
        if (!filled) {
          var cmEl = document.querySelector(".CodeMirror");
          if (cmEl && cmEl.CodeMirror) {
            cmEl.CodeMirror.setValue(code);
            filled = true;
            console.log("[UJAX] CodeMirror 코드 입력 완료");
          }
        }

        // hidden textarea 동기화 (폼 제출 시 이 값이 전송됨)
        var textarea = document.querySelector('textarea[name="source"]');
        if (!textarea) textarea = document.getElementById("source");
        if (textarea) {
          textarea.value = code;
          if (!filled) {
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            console.log("[UJAX] textarea 코드 입력 완료 (fallback)");
          }
        }

        if (!filled && !textarea) {
          console.warn("[UJAX] 에디터를 찾을 수 없음");
        }
      },
      args: [code],
    });

    // 4) Turnstile 대기 (최대 10초)
    const TURNSTILE_TIMEOUT = 10_000;
    const start = Date.now();
    while (Date.now() - start < TURNSTILE_TIMEOUT) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: submitTabId },
        func: () => {
          var frame = document.querySelector(
            'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]'
          );
          if (!frame) return "no-turnstile";
          var input = document.querySelector('input[name="cf-turnstile-response"]');
          return input && input.value ? "ready" : "waiting";
        },
      });

      if (result.result === "no-turnstile" || result.result === "ready") {
        console.log(`[UJAX] Turnstile: ${result.result}`);
        break;
      }
      await sleep(300);
    }

    // 5) 제출 안내 UI 삽입 (자동 클릭 대신 사용자가 직접 제출)
    await chrome.scripting.executeScript({
      target: { tabId: submitTabId },
      func: () => {
        // 안내 배너
        var banner = document.createElement("div");
        banner.id = "ujax-submit-banner";
        banner.style.cssText = [
          "position:fixed", "top:0", "left:0", "right:0", "z-index:99999",
          "background:#4f46e5", "color:#fff",
          "padding:14px 20px", "font-size:15px", "font-weight:bold",
          "text-align:center", "box-shadow:0 2px 10px rgba(0,0,0,0.35)",
          "display:flex", "align-items:center", "justify-content:center", "gap:10px",
          "font-family:sans-serif", "letter-spacing:0.3px",
        ].join(";");
        banner.innerHTML =
          "<span style='font-size:18px'>✅</span>" +
          "<span>UJAX: 코드와 언어가 자동으로 입력되었습니다. &nbsp;" +
          "<strong style='text-decoration:underline'>제출하기</strong> 버튼을 눌러주세요!</span>" +
          "<span style='font-size:18px'>👇</span>";
        document.body.prepend(banner);

        // 제출 버튼 강조
        var btn =
          document.getElementById("submit_button") ||
          document.querySelector('button[type="submit"]') ||
          document.querySelector('input[type="submit"]') ||
          document.querySelector("#submit-form button");
        if (btn) {
          btn.style.cssText += [
            ";outline:3px solid #4f46e5",
            "outline-offset:4px",
            "box-shadow:0 0 0 6px rgba(79,70,229,0.25)",
            "transform:scale(1.08)",
            "transition:all 0.2s",
          ].join(";");
        }
        console.log("[UJAX] 제출 안내 UI 삽입 완료");
      },
    });

    // 6) 사용자가 실제로 제출 버튼을 눌러 status로 넘어갈 때만 감시를 활성화
    armSubmissionCaptureOnStatusRedirect(submitTabId);

    console.log(`[UJAX] 코드 입력 완료, 사용자 제출 대기: ${normalizedProblemNum}번`);
  } catch (err) {
    console.error("[UJAX] 자동 제출 플로우 오류:", err);
    await notifySubmissionSkip(
      {
        problemNum: normalizedProblemNum,
        submissionId: "N/A",
        language,
        reasonCode: "SUBMIT_FLOW_ERROR",
      },
      "[UJAX] 제출 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요."
    );
    await closeSubmitFlowTabs(submitTabId || lastSubmitTabId);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== lastSubmitTabId) return;
  clearSubmitStatusArmWatcher();
  pendingSubmitExpectedBojId = null;
  pendingSubmitProblemNum = null;
  lastSubmitTabId = null;
  clearSubmitRuntimeState().catch(() => { });
  clearActiveSubmissionFlow().catch(() => { });
  clearAllPendingSourceRequests().catch(() => { });
  chrome.storage.local.remove([
    "expectedSubmissionBojId",
    "expectedSubmissionProblemNum",
    "expectingSubmission",
  ]).catch(() => { });
});

let runtimeInitPromise = null;

async function initializeRuntimeState() {
  if (runtimeInitPromise) return runtimeInitPromise;
  runtimeInitPromise = (async () => {
    await restoreSubmitRuntimeState();
    await ensureBridgeInjected();
    await resumeActiveSubmissionFlowIfNeeded();
  })().finally(() => {
    runtimeInitPromise = null;
  });
  return runtimeInitPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  initializeRuntimeState().catch(() => { });
});

chrome.runtime.onStartup.addListener(() => {
  initializeRuntimeState().catch(() => { });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isUjaxFrontUrl(tab.url)) return;
  injectBridgeToTab(tabId).catch(() => { });
});

// 서비스 워커가 재기동되었을 때 기존 UJAX 탭에 브릿지 재주입
initializeRuntimeState().catch(() => { });

console.log("[UJAX] Background service worker 시작");
