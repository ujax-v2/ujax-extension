// background.js (Service Worker)
// ──────────────────────────────────────────────────────────────
// 문제 데이터 수신 → 중복 체크 → solved.ac 보강 → 백엔드 전송
// + 백준 아이디 자동 연동
// ──────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:8080";
const PROBLEM_INGEST_PATH = "/api/v1/problems/ingest";
const SUBMISSION_INGEST_PATH = "/api/v1/submissions/ingest";
const USER_ME_PATH = "/api/v1/users/me";

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
async function sendToBackend(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    console.error("[UJAX] 백준 아이디 연동 네트워크 오류:", err.message);
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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "problemData") {
    handleProblemData(message.data);
    return;
  }

  if (message?.type === "submissionData") {
    handleSubmissionData(message.data);
    return;
  }

  if (message?.type === "manualCrawl") {
    const problemNum = message.problemNum;
    chrome.tabs.create({
      url: `https://www.acmicpc.net/problem/${problemNum}`,
      active: true,
    });
    return;
  }

  // 백준 아이디 감지 (bojDetect.js)
  if (message?.type === "bojUsername") {
    chrome.storage.local.set({ bojId: message.username });
    linkBaekjoonId();
    return;
  }

  // UJAX 토큰 수신 (ujaxBridge.js)
  if (message?.type === "ujaxToken") {
    if (message.token) {
      chrome.storage.local.set({ ujaxToken: message.token });
      linkBaekjoonId();
    } else {
      chrome.storage.local.remove(["ujaxToken", "bojIdLinked"]);
    }
    return;
  }
});

async function handleProblemData(data) {
  const problemNum = Number(data.problemNum);
  if (!problemNum || !data.title) return;

  if (await isAlreadyCrawled(problemNum)) {
    console.log(`[UJAX] 스킵: ${problemNum}번 (이미 수집됨)`);
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
    } else if (res.status === 409) {
      await addToCrawledSet(problemNum);
      console.log(`[UJAX] 이미 등록됨: ${problemNum}번 (캐시 갱신)`);
    } else {
      console.warn(`[UJAX] 등록 실패: ${problemNum}번 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.error(`[UJAX] 네트워크 오류: ${problemNum}번`, err.message);
  }
}

// ──────────────────────────────────────────────────────────────
// 제출 데이터 처리
// ──────────────────────────────────────────────────────────────

async function fetchSourceCode(submissionId) {
  try {
    const res = await fetch(
      `https://www.acmicpc.net/source/${submissionId}`,
      { credentials: "include" }
    );
    if (!res.ok) return "";

    const html = await res.text();
    const match = html.match(
      /<textarea[^>]*class="[^"]*codemirror-textarea[^"]*"[^>]*>([\s\S]*?)<\/textarea>/
    );
    return match ? match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
  } catch {
    return "";
  }
}

async function handleSubmissionData(data) {
  const submissionId = Number(data.submissionId);
  if (!submissionId) return;

  if (await isAlreadySentSubmission(submissionId)) {
    console.log(`[UJAX] 제출 스킵: ${submissionId}번 (이미 전송됨)`);
    return;
  }

  const code = await fetchSourceCode(submissionId);

  const payload = {
    submissionId: submissionId,
    problemNum: data.problemNum,
    username: data.username,
    verdict: data.verdict,
    time: data.time || "",
    memory: data.memory || "",
    language: data.language || "",
    codeLength: data.codeLength || "",
    code: code,
  };

  try {
    const res = await sendToBackend(SUBMISSION_INGEST_PATH, payload);

    if (res.ok) {
      await addToSentSubmissionSet(submissionId);
      console.log(`[UJAX] 제출 등록 완료: ${submissionId}번 (${data.verdict})`);
    } else if (res.status === 409) {
      await addToSentSubmissionSet(submissionId);
      console.log(`[UJAX] 제출 이미 등록됨: ${submissionId}번 (캐시 갱신)`);
    } else {
      console.warn(`[UJAX] 제출 등록 실패: ${submissionId}번 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.error(`[UJAX] 제출 네트워크 오류: ${submissionId}번`, err.message);
  }
}

console.log("[UJAX] Background service worker 시작");
