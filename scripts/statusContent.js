// statusContent.js
// ──────────────────────────────────────────────────────────────
// 백준 채점 현황 페이지(acmicpc.net/status)에서 실행되는 Content Script
// 대상 BOJ ID(+문제 번호)의 행을 감시하여, 채점 완료 시 1회 전송한다.
// expectingSubmission 플래그가 있으면 이미 최종 결과여도 즉시 전송한다.
// ──────────────────────────────────────────────────────────────
(function () {
  const STATUS_MONITOR_ATTR = "data-ujax-status-monitor";
  const rootEl = document.documentElement;
  if (rootEl?.getAttribute(STATUS_MONITOR_ATTR) === "1") {
    console.log("[UJAX] 채점 현황 모니터링 중복 초기화 방지");
    return;
  }
  if (rootEl) {
    rootEl.setAttribute(STATUS_MONITOR_ATTR, "1");
  }

  const WAIT_RE = /(기다리는|채점 준비 중|채점 중|컴파일 중|Judging|Waiting|Compiling|Preparing)/;
  const TARGET_ROW_TIMEOUT_MS = 12_000;
  let observing = false;
  let sent = false;
  let expectingNew = false;
  let targetBojId = "";
  let targetProblemNum = null;
  let expectStartAt = 0;
  let iv = null;

  function normalizeBojId(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeProblemNum(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function armExpectation() {
    expectingNew = true;
    observing = false;
    expectStartAt = Date.now();
    chrome.storage.local.remove("expectingSubmission");
  }

  // 자동 제출 플래그 확인 (background.js가 제출 전 설정)
  chrome.storage.local.get(
    ["expectingSubmission", "expectedSubmissionBojId", "expectedSubmissionProblemNum"],
    ({ expectingSubmission, expectedSubmissionBojId, expectedSubmissionProblemNum }) => {
      if (expectingSubmission) {
        armExpectation();
      }
      targetBojId = normalizeBojId(expectedSubmissionBojId);
      targetProblemNum = normalizeProblemNum(expectedSubmissionProblemNum);
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.expectingSubmission?.newValue) {
      armExpectation();
    }
    if (changes.expectedSubmissionBojId) {
      targetBojId = normalizeBojId(changes.expectedSubmissionBojId.newValue);
    }
    if (changes.expectedSubmissionProblemNum) {
      targetProblemNum = normalizeProblemNum(changes.expectedSubmissionProblemNum.newValue);
    }
  });

  function parseRow(tr) {
    const tds = tr?.querySelectorAll("td");
    if (!tds || tds.length < 8) return null;

    const submissionId = (tds[0]?.innerText || "").trim();
    const userLink = tds[1]?.querySelector('a[href^="/user/"]');
    const usernameFromLink = userLink?.getAttribute("href")?.replace("/user/", "").split("/")[0].trim();
    const username = (usernameFromLink || tds[1]?.innerText || "").trim();
    const link = tds[2]?.querySelector("a");
    const problemNum = link
      ? Number(new URL(link.href).pathname.split("/").pop())
      : Number((tds[2]?.innerText || "").replace(/\D/g, "")) || null;
    const verdict = (tds[3]?.innerText || "").trim();
    const memory = (tds[4]?.innerText || "").trim();
    const time = (tds[5]?.innerText || "").trim();
    const language = (tds[6]?.innerText || "").trim();
    const codeLength = (tds[7]?.innerText || "").trim();

    return { submissionId, username, problemNum, verdict, time, memory, language, codeLength };
  }

  function isTargetRow(data) {
    if (!data) return false;
    if (normalizeBojId(data.username) !== targetBojId) return false;
    if (targetProblemNum && Number(data.problemNum || 0) !== targetProblemNum) return false;
    return true;
  }

  function pickTargetRow() {
    const rows = [...document.querySelectorAll("#status-table tbody tr")];
    if (rows.length === 0) return null;
    if (!targetBojId) return null;

    for (const row of rows) {
      const data = parseRow(row);
      if (isTargetRow(data)) {
        return row;
      }
    }
    return null;
  }

  function getTopRowData() {
    const topRow = document.querySelector("#status-table tbody tr");
    return parseRow(topRow);
  }

  function sendResult(data) {
    if (sent) return;
    sent = true;
    clearInterval(iv);
    chrome.runtime.sendMessage({ type: "submissionData", data });
    console.log(`[UJAX] 채점 결과 전송: ${data.submissionId}번 (${data.verdict})`);
  }

  function sendSkip(reasonCode, reasonMessage, extra = {}) {
    if (sent) return;
    sent = true;
    clearInterval(iv);
    chrome.runtime.sendMessage({
      type: "submissionSkip",
      data: {
        reasonCode,
        reasonMessage,
        problemNum: targetProblemNum,
        detectedUsername: extra.detectedUsername || null,
      },
    });
    console.log(`[UJAX] 제출 스킵 전송: ${reasonCode}`);
  }

  function maybeSendNoMatchSkip() {
    if (!expectingNew || sent) return;
    if (!expectStartAt) return;
    if (Date.now() - expectStartAt < TARGET_ROW_TIMEOUT_MS) return;

    expectingNew = false;

    if (!targetBojId) {
      sendSkip(
        "MISSING_BOJ_ID",
        "[UJAX] 제출 확인 실패: 설정 > 프로필에서 백준 아이디를 확인해주세요."
      );
      return;
    }

    const topData = getTopRowData();
    const topUsername = normalizeBojId(topData?.username);
    if (topUsername && topUsername !== targetBojId) {
      sendSkip(
        "BOJ_ID_MISMATCH",
        `[UJAX] 제출 확인 실패: BOJ 로그인 계정(${topUsername})과 설정 아이디(${targetBojId})가 다릅니다.`,
        { detectedUsername: topUsername }
      );
      return;
    }

    sendSkip(
      "SUBMISSION_NOT_FOUND",
      "[UJAX] 제출 확인 실패: 제출 내역 확인이 지연되고 있습니다. 잠시 후 다시 시도해주세요."
    );
  }

  function attachObserver() {
    if (sent) return;
    if (!expectingNew) return;

    const row = pickTargetRow();
    if (!row) {
      maybeSendNoMatchSkip();
      return;
    }

    const dataNow = parseRow(row);
    if (!dataNow) return;

    if (!WAIT_RE.test(dataNow.verdict)) {
      console.log(`[UJAX] 최종 결과 즉시 감지: ${dataNow.submissionId}번 (${dataNow.verdict})`);
      expectingNew = false;
      sendResult(dataNow);
      return;
    }

    if (observing) return;

    observing = true;
    expectingNew = false;
    console.log(`[UJAX] 채점 대기 감지: ${dataNow.submissionId}번 (${dataNow.verdict})`);

    const verdictCell = row.querySelector("td:nth-child(4)");
    if (!verdictCell) return;

    const mo = new MutationObserver(() => {
      if (sent) return;
      const updated = parseRow(row);
      if (!updated) return;
      if (WAIT_RE.test(updated.verdict)) return;
      mo.disconnect();
      sendResult(updated);
    });

    mo.observe(verdictCell, { childList: true, subtree: true, characterData: true });
  }

  function checkObservedResult() {
    if (!observing || sent) return;
    const row = pickTargetRow();
    if (!row) return;
    const updated = parseRow(row);
    if (!updated) return;
    if (WAIT_RE.test(updated.verdict)) return;
    sendResult(updated);
  }

  iv = setInterval(() => {
    if (sent) {
      clearInterval(iv);
      return;
    }
    attachObserver();
    checkObservedResult();
  }, 400);

  console.log("[UJAX] 채점 현황 모니터링 시작");
})();
