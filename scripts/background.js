// background.js (Service Worker)
// ──────────────────────────────────────────────────────────────
// 문제 데이터 수신 → 중복 체크 → solved.ac 보강 → 백엔드 전송
// + 백준 아이디 자동 연동
// + On-Demand 크롤링 관리 (pendingCrawls)
// ──────────────────────────────────────────────────────────────

const API_BASE = "https://ujax.kro.kr";
const PROBLEM_INGEST_PATH = "/api/v1/problems/ingest";
const SUBMISSION_INGEST_PATH = "/api/v1/submissions/ingest";
const USER_ME_PATH = "/api/v1/users/me";

// UJAX 프론트엔드 URL 패턴
const UJAX_FRONT_URLS = ["https://ujax.kro.kr/*"];

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
  await chrome.storage.local.set({ crawledProblems: [...set] });
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
    };

    for (const tab of tabs) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (msg) => { window.postMessage(msg, "*"); },
        args: [payload],
      });
    }
    console.log(`[UJAX] 프론트엔드에 결과 전달: ${data.submissionId}번 (${data.verdict})`);
  } catch (err) {
    console.error(`[UJAX] 프론트엔드 결과 전달 실패:`, err);
  }
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
          window.postMessage({ type: "ujaxTokenRefreshed", token: data.accessToken }, "*");
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
// 백준 아이디 ↔ UJAX 계정 자동 연동
// ──────────────────────────────────────────────────────────────

async function linkBaekjoonId() {
  const { ujaxToken, bojId, bojIdLinked } = await chrome.storage.local.get([
    "ujaxToken",
    "bojId",
    "bojIdLinked",
  ]);

  if (!ujaxToken || !bojId) return;
  if (bojIdLinked === bojId) return; // 이미 같은 아이디로 연동 완료

  try {
    const res = await fetch(`${API_BASE}${USER_ME_PATH}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ujaxToken}`,
      },
      body: JSON.stringify({ baekjoonId: bojId }),
    });

    if (res.ok) {
      await chrome.storage.local.set({ bojIdLinked: bojId });
      console.log(`[UJAX] 백준 아이디 연동 완료: ${bojId}`);
    } else if (res.status === 401) {
      // 토큰 만료 → 다음 토큰 갱신 시 재시도
      await chrome.storage.local.remove("ujaxToken");
      console.warn("[UJAX] 토큰 만료, 다음 로그인 시 재연동");
    } else {
      console.warn(`[UJAX] 백준 아이디 연동 실패 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.error("[UJAX] 백준 아이디 연동 네트워크 오류:", err);
  }
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
  await chrome.storage.local.set({ sentSubmissions: [...set] });
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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "problemData") {
    handleProblemData(message.data, sender.tab?.id);
    return true; // SW를 살려두기 위해 async 핸들러는 반드시 true 반환
  }

  if (message?.type === "submissionData") {
    handleSubmissionData(message.data, sender.tab?.id);
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
      console.log(`[UJAX] 소스 코드 수신 완료: ${sid}번 (${(message.code || "").length}자)`);
    }
    return true;
  }

  // 팝업 수동 크롤링
  if (message?.type === "manualCrawl") {
    const problemNum = message.problemNum;
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
    const problemNum = message.problemNum;
    addToPendingCrawls(problemNum).then(() => {
      chrome.tabs.create({
        url: `https://www.acmicpc.net/problem/${problemNum}`,
        active: false,
      });
    }).catch((err) => console.error("[UJAX] crawlRequest 오류:", err));
    return true;
  }

  // 백준 아이디 감지 (bojDetect.js)
  if (message?.type === "bojUsername") {
    chrome.storage.local.set({ bojId: message.username });
    linkBaekjoonId();
    return true;
  }

  // UJAX 토큰 수신 (ujaxBridge.js)
  if (message?.type === "ujaxToken") {
    if (message.token) {
      chrome.storage.local.set({ ujaxToken: message.token });
      linkBaekjoonId();
    } else {
      chrome.storage.local.remove(["ujaxToken", "bojIdLinked"]);
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

        // 8초 타임아웃
        setTimeout(() => {
          const entry = pendingSource.get(sid);
          if (entry) {
            entry.resolve("");
            try { chrome.tabs.remove(tab.id); } catch { }
            pendingSource.delete(sid);
            console.warn(`[UJAX] 소스 코드 수집 타임아웃: ${sid}번`);
          }
        }, 8000);
      }
    );
  });
}

async function handleSubmissionData(data, statusTabId) {
  const submissionId = Number(data.submissionId);
  if (!submissionId) return;

  async function closeBojTabs() {
    await sleep(500);
    const tabIds = new Set();
    if (statusTabId) tabIds.add(statusTabId);
    if (lastSubmitTabId) tabIds.add(lastSubmitTabId);

    for (const id of tabIds) {
      try { await chrome.tabs.remove(id); } catch { }
    }
    lastSubmitTabId = null;
    if (tabIds.size > 0) console.log(`[UJAX] 백준 탭 ${tabIds.size}개 닫기 완료`);
  }

  if (await isAlreadySentSubmission(submissionId)) {
    console.log(`[UJAX] 제출 스킵: ${submissionId}번 (이미 전송됨)`);
    await closeBojTabs();
    return;
  }

  const workspaceProblemId = await getWorkspaceProblemId(data.problemNum);
  if (!workspaceProblemId) {
    console.log(`[UJAX] 제출 스킵: ${submissionId}번 (문제 컨텍스트 없음, problemNum=${data.problemNum})`);
    await closeBojTabs();
    return;
  }

  // 소스 코드 수집: /source/{id} 탭을 열어 sourceContent.js가 코드를 전달
  console.log(`[UJAX] 소스 코드 수집 시작: ${submissionId}번 (언어: "${data.language}")`);
  const code = await openSourceTabAndGetCode(submissionId);

  const payload = {
    workspaceProblemId,
    submissionId: submissionId,
    verdict: data.verdict,
    time: data.time || "",
    memory: data.memory || "",
    language: data.language || "",
    codeLength: data.codeLength || "",
    code: code,
  };

  try {
    const res = await sendToBackend(SUBMISSION_INGEST_PATH, payload, { requireAuth: true });

    if (res.skipped) {
      await closeBojTabs();
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
        }
      } else {
        await chrome.storage.local.remove("ujaxToken");
        console.warn(`[UJAX] 로그인 필요 (제출 ${submissionId}번 스킵)`);
      }
    } else {
      console.warn(`[UJAX] 제출 등록 실패: ${submissionId}번 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.error(`[UJAX] 제출 네트워크 오류: ${submissionId}번`, err);
    console.error(`[UJAX] 오류 상세: name=${err.name}, message=${err.message}, stack=`, err.stack);
  }

  await closeBojTabs();
}

// ──────────────────────────────────────────────────────────────
// 자동 제출 처리
// chrome.scripting.executeScript를 사용하여 CSP 우회
// ──────────────────────────────────────────────────────────────

// 자동 제출로 열린 탭 ID (submit → status 리다이렉트 후에도 같은 탭)
let lastSubmitTabId = null;

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

async function handleSubmitRequest({ problemNum, code, language }) {
  if (!problemNum || !code) {
    console.warn("[UJAX] 제출 요청 데이터 부족");
    return;
  }

  console.log(`[UJAX] 자동 제출 시작: ${problemNum}번 (${language})`);

  // statusContent.js가 최종 상태(컴파일 에러 등)도 즉시 캡처하도록 플래그 설정
  await chrome.storage.local.set({ expectingSubmission: true });

  // 1) 백준 제출 페이지 열기 + 로드 대기
  const tab = await chrome.tabs.create({
    url: `https://www.acmicpc.net/submit/${problemNum}`,
    active: true, // 제출 페이지를 활성 탭으로 열어 Cloudflare 스크립트 차단을 방지
  });
  lastSubmitTabId = tab.id;
  await waitForTabLoad(tab.id);
  await sleep(500); // 에디터 초기화 대기

  // 2) 언어 선택 (DOM 조작 — MAIN world)
  const bojLangId = LANG_TO_BOJ[language];
  if (!bojLangId) {
    console.warn(`[UJAX] 지원하지 않는 언어: ${language}`);
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (langId) => {
      const select = document.getElementById("language");
      if (select) {
        select.value = langId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        // 백준에서 사용하는 jQuery 기반 chosen.js 드롭다운 UI 강제 업데이트
        if (window.jQuery && window.jQuery(select).trigger) {
          window.jQuery(select).trigger("chosen:updated");
        }
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
    target: { tabId: tab.id },
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

  // 4) Turnstile 대기 (최대 60초)
  const TURNSTILE_TIMEOUT = 60_000;
  const start = Date.now();
  let turnstilePassed = false;

  while (Date.now() - start < TURNSTILE_TIMEOUT) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
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
        turnstilePassed = true;
        break;
      }
    } catch (e) {
      console.warn("[UJAX] Turnstile 상태 확인 중 에러(무시됨):", e);
    }
    
    await sleep(500);
  }

  if (!turnstilePassed) {
    console.warn("[UJAX] Turnstile 시간 초과 (60초). 수동 제출 필요.");
    return; // Turnstile을 통과하지 못하면 자동으로 제출 버튼을 누르지 않음
  }

  // 5) 제출 버튼 클릭 (짧게 대기 후)
  await sleep(500);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      var btn =
        document.getElementById("submit_button") ||
        document.querySelector('button[type="submit"]') ||
        document.querySelector('input[type="submit"]') ||
        document.querySelector("#submit-form button") ||
        document.querySelector("form button");
      if (btn) {
        btn.click();
        console.log("[UJAX] 제출 버튼 클릭 완료");
      } else {
        var form = document.querySelector("form");
        if (form) {
          form.submit();
          console.log("[UJAX] 폼 제출 완료 (fallback)");
        } else {
          console.warn("[UJAX] 제출 버튼/폼을 찾을 수 없음");
        }
      }
    },
  });

  console.log(`[UJAX] 자동 제출 완료: ${problemNum}번`);
}

console.log("[UJAX] Background service worker 시작");
